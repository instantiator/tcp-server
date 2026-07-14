import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import axios from 'axios';
import { z } from 'zod';
import { getReadOnlyMessage, storagePrompts } from '../storage-prompts';
import { storageToolDescriptions } from '../storage-tool-descriptions';

/** Shape of a single entry returned by list/search tools. */
interface FileEntry {
  key: string;
  name: string;
  size: number;
  lastModified: string;
}

/** Properties returned by get_file_properties. */
interface FileProperties {
  key: string;
  exists: boolean;
  size?: number;
  contentType?: string;
  lastModified?: string;
}

/** A material resolved server-side to a concrete key (or literal inline text). */
interface ResolvedMaterial {
  name: string;
  key: string | null;
  inlineText?: string;
}

/** The caller's storage scope, resolved by `GET /internal/agent/:id/storage-scope`. */
interface StorageScope {
  mode: string;
  readOnly: boolean;
  workingPrefix: string;
  materials: ResolvedMaterial[];
}

/** MCP tool result envelope — index signature satisfies the SDK's Zod-inferred type. */
interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
}

/** The working-directory inspect tools an agent keeps in a read-only scope. */
const READ_ONLY_WORKING_TOOLS = [
  'read_working_file',
  'list_working_files',
  'get_working_file_properties',
];

/**
 * Validates a model-supplied filename and joins it under a working prefix.
 * Rejects absolute paths and any `..` segment so a resolved key can never
 * escape the working directory.
 *
 * @throws {Error} with a corrective message the tool relays to the model.
 */
function resolveScopedKey(prefix: string, filename: string): string {
  const norm = filename.trim().replace(/\\/g, '/');
  if (norm === '') {
    throw new Error('A filename is required.');
  }
  if (norm.startsWith('/')) {
    throw new Error(`Filename must be relative, not absolute: '${filename}'.`);
  }
  if (norm.split('/').some((segment) => segment === '..')) {
    throw new Error(
      `Filename must not contain '..' path segments: '${filename}'.`,
    );
  }
  return `${prefix}${norm}`;
}

/**
 * Builds fresh {@link McpServer} instances pre-loaded with all storage tools.
 * A new server is created per request so state is never shared across sessions.
 * Tool handlers are public methods so integration tests can call them directly.
 *
 * Two tiers of tool:
 * - **Read-only exploration** (`list_files`, `read_file`, `search_files`, …) —
 *   thin proxies over `/internal/storage/*` letting agents browse shared storage.
 * - **Assignment-scoped** (`*_working_file`, `*_material_file`) — the model
 *   supplies only a filename; the working-directory prefix and materials are
 *   resolved server-side from the caller's assignment
 *   (`GET /internal/agent/:id/storage-scope`), so an agent can only write inside
 *   its own working area, and qa-mode callers are read-only.
 *
 * All file-action logic (validation, soft-delete, content analysis, audit)
 * lives on `lcp-server` behind `/internal/storage/*` — this service is a thin
 * HTTP proxy plus the MCP `ToolResult` presentation layer.
 */
@Injectable()
export class StorageToolsService {
  private readonly logger = new Logger(StorageToolsService.name);
  private readonly serverUrl: string;
  private readonly apiKey: string;

  constructor(private readonly config: ConfigService) {
    this.serverUrl = this.config.getOrThrow<string>('LCP_SERVER_URL');
    this.apiKey = this.config.getOrThrow<string>('INTERNAL_API_KEY');
  }

  /** Creates and returns a configured McpServer with all storage tools registered. */
  createServer(): McpServer {
    const server = new McpServer({ name: 'lcp-mcp-storage', version: '1.0.0' });

    // Read-only exploration of shared storage.
    this.registerDescribeServer(server);
    this.registerDescribeFolder(server);
    this.registerListFiles(server);
    this.registerReadFile(server);
    this.registerSearchFiles(server);
    this.registerGetFileProperties(server);
    this.registerGetFileSummary(server);

    // Assignment-scoped working files.
    this.registerListWorkingFiles(server);
    this.registerGetWorkingFileProperties(server);
    this.registerReadWorkingFile(server);
    this.registerAppendWorkingFile(server);
    this.registerReplaceInWorkingFile(server);
    this.registerDeleteWorkingFile(server);
    this.registerRestoreWorkingFile(server);
    this.registerRenameWorkingFile(server);

    // Assignment-scoped materials.
    this.registerListMaterialFiles(server);
    this.registerGetMaterialFileProperties(server);
    this.registerReadMaterialFile(server);

    return server;
  }

  // Read-only exploration handlers (public for testability).

  async listFiles(prefix?: string): Promise<ToolResult> {
    const { entries } = await this.post<{ entries: FileEntry[] }>('list', {
      prefix,
    });
    return this.textResult(JSON.stringify(entries, null, 2));
  }

  async readFile(path: string): Promise<ToolResult> {
    try {
      const { content } = await this.post<{ content: string }>('read', {
        path,
      });
      return this.textResult(content);
    } catch (e) {
      return this.textResult(this.extractErrorMessage(e));
    }
  }

  async searchFiles(prefix?: string, pattern?: string): Promise<ToolResult> {
    const { entries } = await this.post<{ entries: FileEntry[] }>('search', {
      prefix,
      pattern,
    });
    return this.textResult(JSON.stringify(entries, null, 2));
  }

  async getFileProperties(path: string): Promise<ToolResult> {
    try {
      const props = await this.post<FileProperties>('properties', { path });
      return this.textResult(JSON.stringify(props, null, 2));
    } catch (e) {
      return this.textResult(this.extractErrorMessage(e));
    }
  }

  async getFileSummary(path: string): Promise<ToolResult> {
    try {
      const summary = await this.post<Record<string, unknown>>('summary', {
        path,
      });
      return this.textResult(JSON.stringify(summary, null, 2));
    } catch (e) {
      return this.textResult(this.extractErrorMessage(e));
    }
  }

  // Assignment-scoped working-file handlers (public for testability).

  async listWorkingFiles(agentId: string): Promise<ToolResult> {
    try {
      const scope = await this.fetchScope(agentId);
      const { entries } = await this.post<{ entries: FileEntry[] }>('list', {
        prefix: scope.workingPrefix,
      });
      return this.textResult(JSON.stringify(entries, null, 2));
    } catch (e) {
      return this.textResult(this.extractErrorMessage(e));
    }
  }

  async getWorkingFileProperties(
    agentId: string,
    filename: string,
  ): Promise<ToolResult> {
    try {
      const scope = await this.fetchScope(agentId);
      const key = resolveScopedKey(scope.workingPrefix, filename);
      const props = await this.post<FileProperties>('properties', {
        path: key,
      });
      return this.textResult(JSON.stringify(props, null, 2));
    } catch (e) {
      return this.textResult(this.extractErrorMessage(e));
    }
  }

  async readWorkingFile(
    agentId: string,
    filename: string,
  ): Promise<ToolResult> {
    try {
      const scope = await this.fetchScope(agentId);
      const key = resolveScopedKey(scope.workingPrefix, filename);
      const { content } = await this.post<{ content: string }>('read', {
        path: key,
      });
      return this.textResult(content);
    } catch (e) {
      return this.textResult(this.extractErrorMessage(e));
    }
  }

  async appendWorkingFile(
    agentId: string,
    filename: string,
    content: string,
  ): Promise<ToolResult> {
    try {
      const scope = await this.fetchScope(agentId);
      if (scope.readOnly)
        return this.textResult(
          getReadOnlyMessage('append_working_file', READ_ONLY_WORKING_TOOLS),
        );
      const key = resolveScopedKey(scope.workingPrefix, filename);
      const { created } = await this.post<{ created: boolean }>('append', {
        path: key,
        content,
        originators: { agent: agentId },
      });
      return this.textResult(
        `${created ? 'Created' : 'Appended to'} working file: ${filename}`,
      );
    } catch (e) {
      return this.textResult(this.extractErrorMessage(e));
    }
  }

  async replaceInWorkingFile(
    agentId: string,
    filename: string,
    find: string,
    replace: string,
  ): Promise<ToolResult> {
    try {
      const scope = await this.fetchScope(agentId);
      if (scope.readOnly)
        return this.textResult(
          getReadOnlyMessage(
            'replace_in_working_file',
            READ_ONLY_WORKING_TOOLS,
          ),
        );
      const key = resolveScopedKey(scope.workingPrefix, filename);
      const { count } = await this.post<{ count: number }>('replace', {
        path: key,
        find,
        replace,
        originators: { agent: agentId },
      });
      return this.textResult(
        `Replaced ${count} occurrence(s) in working file: ${filename}`,
      );
    } catch (e) {
      return this.textResult(this.extractErrorMessage(e));
    }
  }

  async deleteWorkingFile(
    agentId: string,
    filename: string,
  ): Promise<ToolResult> {
    try {
      const scope = await this.fetchScope(agentId);
      if (scope.readOnly)
        return this.textResult(
          getReadOnlyMessage('delete_working_file', READ_ONLY_WORKING_TOOLS),
        );
      const key = resolveScopedKey(scope.workingPrefix, filename);
      await this.post('delete', {
        path: key,
        originators: { agent: agentId },
      });
      return this.textResult(
        `Deleted working file: ${filename} (restorable via restore_working_file)`,
      );
    } catch (e) {
      return this.textResult(this.extractErrorMessage(e));
    }
  }

  async restoreWorkingFile(
    agentId: string,
    filename: string,
  ): Promise<ToolResult> {
    try {
      const scope = await this.fetchScope(agentId);
      if (scope.readOnly)
        return this.textResult(
          getReadOnlyMessage('restore_working_file', READ_ONLY_WORKING_TOOLS),
        );
      const key = resolveScopedKey(scope.workingPrefix, filename);
      await this.post('restore', {
        path: key,
        originators: { agent: agentId },
      });
      return this.textResult(`Restored working file: ${filename}`);
    } catch (e) {
      return this.textResult(this.extractErrorMessage(e));
    }
  }

  async renameWorkingFile(
    agentId: string,
    from: string,
    to: string,
  ): Promise<ToolResult> {
    try {
      const scope = await this.fetchScope(agentId);
      if (scope.readOnly)
        return this.textResult(
          getReadOnlyMessage('rename_working_file', READ_ONLY_WORKING_TOOLS),
        );
      // Both ends are confined to the working directory by resolveScopedKey.
      const source = resolveScopedKey(scope.workingPrefix, from);
      const destination = resolveScopedKey(scope.workingPrefix, to);
      await this.post('move', {
        source,
        destination,
        originators: { agent: agentId },
      });
      return this.textResult(`Renamed working file: ${from} → ${to}`);
    } catch (e) {
      return this.textResult(this.extractErrorMessage(e));
    }
  }

  // Assignment-scoped material handlers (public for testability).

  async listMaterialFiles(agentId: string): Promise<ToolResult> {
    try {
      const scope = await this.fetchScope(agentId);
      const list = scope.materials.map((m) => ({
        name: m.name,
        kind: m.key === null ? 'inline-text' : 'file',
      }));
      return this.textResult(JSON.stringify(list, null, 2));
    } catch (e) {
      return this.textResult(this.extractErrorMessage(e));
    }
  }

  async getMaterialFileProperties(
    agentId: string,
    filename: string,
  ): Promise<ToolResult> {
    try {
      const scope = await this.fetchScope(agentId);
      const material = this.findMaterial(scope, filename);
      if (!material) return this.textResult(this.materialNotFound(filename));
      if (material.key === null) {
        return this.textResult(
          JSON.stringify(
            {
              name: material.name,
              kind: 'inline-text',
              exists: true,
              size: Buffer.byteLength(material.inlineText ?? '', 'utf-8'),
            },
            null,
            2,
          ),
        );
      }
      const props = await this.post<FileProperties>('properties', {
        path: material.key,
      });
      return this.textResult(JSON.stringify(props, null, 2));
    } catch (e) {
      return this.textResult(this.extractErrorMessage(e));
    }
  }

  async readMaterialFile(
    agentId: string,
    filename: string,
  ): Promise<ToolResult> {
    try {
      const scope = await this.fetchScope(agentId);
      const material = this.findMaterial(scope, filename);
      if (!material) return this.textResult(this.materialNotFound(filename));
      if (material.key === null) {
        return this.textResult(material.inlineText ?? '');
      }
      const { content } = await this.post<{ content: string }>('read', {
        path: material.key,
      });
      return this.textResult(content);
    } catch (e) {
      return this.textResult(this.extractErrorMessage(e));
    }
  }

  /**
   * Proxies to `GET /internal/storage/exists` — used by the `files/exists`
   * internal endpoint (see `StorageCheckController`).
   *
   * Builds the query string manually (`path=a&path=b`) rather than passing
   * an array via axios's `params` option — axios's default array
   * serialisation uses bracket notation (`path[]=a&path[]=b`), which Nest's
   * `@Query('path')` does not recognise as the same key.
   */
  async checkMissingFiles(paths: string[]): Promise<string[]> {
    const query = new URLSearchParams();
    for (const p of paths) query.append('path', p);
    const res = await axios.get<{ missing: string[] }>(
      `${this.serverUrl}/internal/storage/exists?${query.toString()}`,
      { headers: this.headers() },
    );
    return res.data.missing;
  }

  // Private helpers

  /** Resolves the caller's storage scope for the current tool call. */
  private async fetchScope(agentId: string): Promise<StorageScope> {
    const res = await axios.get<StorageScope>(
      `${this.serverUrl}/internal/agent/${agentId}/storage-scope`,
      { headers: this.headers() },
    );
    return res.data;
  }

  private findMaterial(
    scope: StorageScope,
    name: string,
  ): ResolvedMaterial | undefined {
    return scope.materials.find((m) => m.name === name);
  }

  private materialNotFound(name: string): string {
    return `No material named '${name}'. Use list_material_files to see the available materials.`;
  }

  private async post<T>(action: string, body: unknown): Promise<T> {
    const res = await axios.post<T>(
      `${this.serverUrl}/internal/storage/${action}`,
      body,
      { headers: this.headers() },
    );
    return res.data;
  }

  private headers(): Record<string, string> {
    return { 'X-Internal-Api-Key': this.apiKey };
  }

  /** Extracts a friendly message from an lcp-server error response (422 validation errors, 404s, etc.). */
  private extractErrorMessage(error: unknown): string {
    if (axios.isAxiosError(error)) {
      const data = error.response?.data as
        | { message?: string; errors?: { llmHint: string }[] }
        | undefined;
      if (data?.errors?.length) {
        return data.errors.map((e) => e.llmHint).join(' ');
      }
      if (data?.message) return data.message;
      return error.message;
    }
    return error instanceof Error ? error.message : String(error);
  }

  private textResult(text: string): ToolResult {
    return { content: [{ type: 'text', text }] };
  }

  // Server registration

  private registerDescribeServer(server: McpServer): void {
    server.registerTool(
      'describe_server',
      { description: storageToolDescriptions.describe_server },
      (): ToolResult => ({
        content: [{ type: 'text', text: storagePrompts.describe_server }],
      }),
    );
  }

  private registerDescribeFolder(server: McpServer): void {
    server.registerTool(
      'describe_folder',
      {
        description: storageToolDescriptions.describe_folder,
        inputSchema: {
          path: z.string().describe('The folder path prefix to describe.'),
        },
      },
      ({ path }): ToolResult => ({
        content: [{ type: 'text', text: this.describeFolder(path) }],
      }),
    );
  }

  private describeFolder(p: string): string {
    if (p.includes('/tasks/') && p.includes('/materials'))
      return storagePrompts.describe_folder_task_materials;
    if (p.includes('/tasks/') && p.includes('/output'))
      return storagePrompts.describe_folder_task_output;
    if (p.includes('/knowledge/') || p.endsWith('/knowledge'))
      return storagePrompts.describe_folder_knowledge;
    if (p.includes('/finished/reports'))
      return storagePrompts.describe_folder_finished_reports;
    if (p.includes('/finished/specifications'))
      return storagePrompts.describe_folder_finished_specifications;
    if (p.includes('/finished/designs'))
      return storagePrompts.describe_folder_finished_designs;
    if (p.includes('/finished/code'))
      return storagePrompts.describe_folder_finished_code;
    if (p.includes('/finished/other'))
      return storagePrompts.describe_folder_finished_other;
    if (p.includes('/audit/') || p.endsWith('/audit'))
      return storagePrompts.describe_folder_audit;
    return storagePrompts.describe_folder_fallback;
  }

  private registerListFiles(server: McpServer): void {
    server.registerTool(
      'list_files',
      {
        description: storageToolDescriptions.list_files,
        inputSchema: {
          path: z
            .string()
            .optional()
            .describe('Path prefix to list under (default: all files).'),
        },
      },
      ({ path }) => this.listFiles(path),
    );
  }

  private registerReadFile(server: McpServer): void {
    server.registerTool(
      'read_file',
      {
        description: storageToolDescriptions.read_file,
        inputSchema: { path: z.string().describe('The object key to read.') },
      },
      ({ path }) => this.readFile(path),
    );
  }

  private registerSearchFiles(server: McpServer): void {
    server.registerTool(
      'search_files',
      {
        description: storageToolDescriptions.search_files,
        inputSchema: {
          prefix: z
            .string()
            .optional()
            .describe('Path prefix to search under.'),
          pattern: z
            .string()
            .optional()
            .describe(
              'Glob pattern to match against full key (supports * and ?).',
            ),
        },
      },
      ({ prefix, pattern }) => this.searchFiles(prefix, pattern),
    );
  }

  private registerGetFileProperties(server: McpServer): void {
    server.registerTool(
      'get_file_properties',
      {
        description: storageToolDescriptions.get_file_properties,
        inputSchema: {
          path: z.string().describe('The object key to inspect.'),
        },
      },
      ({ path }) => this.getFileProperties(path),
    );
  }

  private registerGetFileSummary(server: McpServer): void {
    server.registerTool(
      'get_file_summary',
      {
        description: storageToolDescriptions.get_file_summary,
        inputSchema: {
          path: z.string().describe('The object key to summarise.'),
        },
      },
      ({ path }) => this.getFileSummary(path),
    );
  }

  // The `agentId` field on scoped tools is injected server-side by
  // McpClientService and never supplied by the model.

  private registerListWorkingFiles(server: McpServer): void {
    server.registerTool(
      'list_working_files',
      {
        description: storageToolDescriptions.list_working_files,
        inputSchema: {
          agentId: z.uuid().describe('The calling agent UUID.'),
        },
      },
      ({ agentId }) => this.listWorkingFiles(agentId),
    );
  }

  private registerGetWorkingFileProperties(server: McpServer): void {
    server.registerTool(
      'get_working_file_properties',
      {
        description: storageToolDescriptions.get_working_file_properties,
        inputSchema: {
          agentId: z.uuid().describe('The calling agent UUID.'),
          filename: z
            .string()
            .describe('Filename relative to your working directory.'),
        },
      },
      ({ agentId, filename }) =>
        this.getWorkingFileProperties(agentId, filename),
    );
  }

  private registerReadWorkingFile(server: McpServer): void {
    server.registerTool(
      'read_working_file',
      {
        description: storageToolDescriptions.read_working_file,
        inputSchema: {
          agentId: z.uuid().describe('The calling agent UUID.'),
          filename: z
            .string()
            .describe('Filename relative to your working directory.'),
        },
      },
      ({ agentId, filename }) => this.readWorkingFile(agentId, filename),
    );
  }

  private registerAppendWorkingFile(server: McpServer): void {
    server.registerTool(
      'append_working_file',
      {
        description: storageToolDescriptions.append_working_file,
        inputSchema: {
          agentId: z.uuid().describe('The calling agent UUID.'),
          filename: z
            .string()
            .describe('Filename relative to your working directory.'),
          content: z.string().describe('The text content to append.'),
        },
      },
      ({ agentId, filename, content }) =>
        this.appendWorkingFile(agentId, filename, content),
    );
  }

  private registerReplaceInWorkingFile(server: McpServer): void {
    server.registerTool(
      'replace_in_working_file',
      {
        description: storageToolDescriptions.replace_in_working_file,
        inputSchema: {
          agentId: z.uuid().describe('The calling agent UUID.'),
          filename: z
            .string()
            .describe('Filename relative to your working directory.'),
          find: z
            .string()
            .describe('The literal string to find (all occurrences replaced).'),
          replace: z.string().describe('The replacement string.'),
        },
      },
      ({ agentId, filename, find, replace }) =>
        this.replaceInWorkingFile(agentId, filename, find, replace),
    );
  }

  private registerDeleteWorkingFile(server: McpServer): void {
    server.registerTool(
      'delete_working_file',
      {
        description: storageToolDescriptions.delete_working_file,
        inputSchema: {
          agentId: z.uuid().describe('The calling agent UUID.'),
          filename: z
            .string()
            .describe('Filename relative to your working directory.'),
        },
      },
      ({ agentId, filename }) => this.deleteWorkingFile(agentId, filename),
    );
  }

  private registerRestoreWorkingFile(server: McpServer): void {
    server.registerTool(
      'restore_working_file',
      {
        description: storageToolDescriptions.restore_working_file,
        inputSchema: {
          agentId: z.uuid().describe('The calling agent UUID.'),
          filename: z
            .string()
            .describe('Filename relative to your working directory.'),
        },
      },
      ({ agentId, filename }) => this.restoreWorkingFile(agentId, filename),
    );
  }

  private registerRenameWorkingFile(server: McpServer): void {
    server.registerTool(
      'rename_working_file',
      {
        description: storageToolDescriptions.rename_working_file,
        inputSchema: {
          agentId: z.uuid().describe('The calling agent UUID.'),
          from: z
            .string()
            .describe('Current filename, relative to your working directory.'),
          to: z
            .string()
            .describe('New filename, relative to your working directory.'),
        },
      },
      ({ agentId, from, to }) => this.renameWorkingFile(agentId, from, to),
    );
  }

  private registerListMaterialFiles(server: McpServer): void {
    server.registerTool(
      'list_material_files',
      {
        description: storageToolDescriptions.list_material_files,
        inputSchema: {
          agentId: z.uuid().describe('The calling agent UUID.'),
        },
      },
      ({ agentId }) => this.listMaterialFiles(agentId),
    );
  }

  private registerGetMaterialFileProperties(server: McpServer): void {
    server.registerTool(
      'get_material_file_properties',
      {
        description: storageToolDescriptions.get_material_file_properties,
        inputSchema: {
          agentId: z.uuid().describe('The calling agent UUID.'),
          filename: z.string().describe('The material name to inspect.'),
        },
      },
      ({ agentId, filename }) =>
        this.getMaterialFileProperties(agentId, filename),
    );
  }

  private registerReadMaterialFile(server: McpServer): void {
    server.registerTool(
      'read_material_file',
      {
        description: storageToolDescriptions.read_material_file,
        inputSchema: {
          agentId: z.uuid().describe('The calling agent UUID.'),
          filename: z.string().describe('The material name to read.'),
        },
      },
      ({ agentId, filename }) => this.readMaterialFile(agentId, filename),
    );
  }
}
