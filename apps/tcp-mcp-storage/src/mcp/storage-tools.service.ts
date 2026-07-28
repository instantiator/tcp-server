import { Injectable, Logger } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  InternalApiClient,
  ToolResult,
  extractServerErrorMessage,
  ok,
  registerDescribeServer,
} from '@tcp/shared';
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

/** The working-directory inspect tools an agent keeps in a read-only scope. */
const READ_ONLY_WORKING_TOOLS = [
  'read_working_file',
  'list_working_files',
  'get_working_file_properties',
  'get_working_file_summary',
];

/**
 * Path segment names reserved by the ADR-007 storage hierarchy
 * (`{company_slug}/tasks/{taskId}/assignments/{orderIndex}/working/...`).
 * A model-supplied filename containing one of these as a whole segment is
 * almost certainly a fully (or partially) resolved storage key echoed back
 * from a prompt, not a genuine subdirectory name — rejected below rather
 * than silently concatenated onto the working prefix, which would otherwise
 * write to a doubly-nested, wrong location.
 */
const RESERVED_PATH_SEGMENTS = new Set([
  'tasks',
  'assignments',
  'materials',
  'completed',
  'working',
]);

/**
 * Validates a model-supplied filename and joins it under a working prefix.
 * Rejects absolute paths, any `..` segment, and any segment that looks like
 * a resolved storage-hierarchy path component, so a resolved key can never
 * escape the working directory — or land in an unintended nested one.
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
  const segments = norm.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new Error(
      `Filename must not contain '..' path segments: '${filename}'.`,
    );
  }
  if (segments.some((segment) => RESERVED_PATH_SEGMENTS.has(segment))) {
    throw new Error(
      `'${filename}' looks like a resolved storage path, not a bare filename. ` +
        `Pass just the filename shown in Materials/Expected outputs (e.g. 'report.md'), not a full storage key.`,
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
 * lives on `tcp-server` behind `/internal/storage/*` — this service is a thin
 * HTTP proxy plus the MCP `ToolResult` presentation layer.
 */
@Injectable()
export class StorageToolsService {
  private readonly logger = new Logger(StorageToolsService.name);

  constructor(private readonly api: InternalApiClient) {}

  /** Creates and returns a configured McpServer with all storage tools registered. */
  createServer(): McpServer {
    const server = new McpServer({ name: 'tcp-mcp-storage', version: '1.0.0' });

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
    this.registerGetWorkingFileSummary(server);
    this.registerReadWorkingFile(server);
    this.registerCreateWorkingFile(server);
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
    return ok(JSON.stringify(entries, null, 2));
  }

  async readFile(path: string): Promise<ToolResult> {
    try {
      const { content } = await this.post<{ content: string }>('read', {
        path,
      });
      return ok(content);
    } catch (e) {
      return ok(extractServerErrorMessage(e));
    }
  }

  async searchFiles(prefix?: string, pattern?: string): Promise<ToolResult> {
    const { entries } = await this.post<{ entries: FileEntry[] }>('search', {
      prefix,
      pattern,
    });
    return ok(JSON.stringify(entries, null, 2));
  }

  async getFileProperties(path: string): Promise<ToolResult> {
    try {
      const props = await this.post<FileProperties>('properties', { path });
      return ok(JSON.stringify(props, null, 2));
    } catch (e) {
      return ok(extractServerErrorMessage(e));
    }
  }

  async getFileSummary(path: string): Promise<ToolResult> {
    try {
      const summary = await this.post<Record<string, unknown>>('summary', {
        path,
      });
      return ok(JSON.stringify(summary, null, 2));
    } catch (e) {
      return ok(extractServerErrorMessage(e));
    }
  }

  // Assignment-scoped working-file handlers (public for testability).

  async listWorkingFiles(agentId: string): Promise<ToolResult> {
    try {
      const scope = await this.fetchScope(agentId);
      const { entries } = await this.post<{ entries: FileEntry[] }>('list', {
        prefix: scope.workingPrefix,
      });
      return ok(JSON.stringify(entries, null, 2));
    } catch (e) {
      return ok(extractServerErrorMessage(e));
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
      return ok(JSON.stringify(props, null, 2));
    } catch (e) {
      return ok(extractServerErrorMessage(e));
    }
  }

  async getWorkingFileSummary(
    agentId: string,
    filename: string,
  ): Promise<ToolResult> {
    try {
      const scope = await this.fetchScope(agentId);
      const key = resolveScopedKey(scope.workingPrefix, filename);
      const summary = await this.post<Record<string, unknown>>('summary', {
        path: key,
      });
      return ok(JSON.stringify(summary, null, 2));
    } catch (e) {
      return ok(extractServerErrorMessage(e));
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
      return ok(content);
    } catch (e) {
      return ok(extractServerErrorMessage(e));
    }
  }

  /**
   * Runs a working-file mutation behind the checks every one of them needs:
   * the caller's scope is resolved, a read-only scope is refused, and the
   * model-supplied filename is confined to the working directory before `run`
   * sees it. Failures come back as a readable tool result, not an exception.
   *
   * Routing every mutation through here is what makes the read-only gate
   * impossible to forget when a new working-file tool is added.
   *
   * @param tool - Tool name, named in the read-only refusal message.
   * @param filename - Model-supplied name, resolved to `key` for `run`.
   * @param run - Performs the action and returns the message for the model.
   *   Receives the scope too, for tools that resolve a second path.
   */
  private async workingFileAction(
    agentId: string,
    tool: string,
    filename: string,
    run: (key: string, scope: StorageScope) => Promise<string>,
  ): Promise<ToolResult> {
    try {
      const scope = await this.fetchScope(agentId);
      if (scope.readOnly) {
        return ok(getReadOnlyMessage(tool, READ_ONLY_WORKING_TOOLS));
      }
      const key = resolveScopedKey(scope.workingPrefix, filename);
      return ok(await run(key, scope));
    } catch (e) {
      return ok(extractServerErrorMessage(e));
    }
  }

  async createWorkingFile(
    agentId: string,
    filename: string,
    content: string,
    overwrite?: boolean,
  ): Promise<ToolResult> {
    return this.workingFileAction(
      agentId,
      'create_working_file',
      filename,
      async (key) => {
        const props = await this.post<FileProperties>('properties', {
          path: key,
        });
        if (props.exists && !overwrite) {
          return `Working file '${filename}' already exists. Set overwrite: true to replace it, or use append_working_file to add to it.`;
        }
        await this.post('write', {
          path: key,
          content,
          overwrite: true,
          originators: { agent: agentId },
        });
        return `${props.exists ? 'Replaced' : 'Created'} working file: ${filename}`;
      },
    );
  }

  async appendWorkingFile(
    agentId: string,
    filename: string,
    content: string,
  ): Promise<ToolResult> {
    return this.workingFileAction(
      agentId,
      'append_working_file',
      filename,
      async (key) => {
        const { created } = await this.post<{ created: boolean }>('append', {
          path: key,
          content,
          originators: { agent: agentId },
        });
        return `${created ? 'Created' : 'Appended to'} working file: ${filename}`;
      },
    );
  }

  async replaceInWorkingFile(
    agentId: string,
    filename: string,
    find: string,
    replace: string,
  ): Promise<ToolResult> {
    return this.workingFileAction(
      agentId,
      'replace_in_working_file',
      filename,
      async (key) => {
        const { count } = await this.post<{ count: number }>('replace', {
          path: key,
          find,
          replace,
          originators: { agent: agentId },
        });
        return `Replaced ${count} occurrence(s) in working file: ${filename}`;
      },
    );
  }

  async deleteWorkingFile(
    agentId: string,
    filename: string,
  ): Promise<ToolResult> {
    return this.workingFileAction(
      agentId,
      'delete_working_file',
      filename,
      async (key) => {
        await this.post('delete', {
          path: key,
          originators: { agent: agentId },
        });
        return `Deleted working file: ${filename} (restorable via restore_working_file)`;
      },
    );
  }

  async restoreWorkingFile(
    agentId: string,
    filename: string,
  ): Promise<ToolResult> {
    return this.workingFileAction(
      agentId,
      'restore_working_file',
      filename,
      async (key) => {
        await this.post('restore', {
          path: key,
          originators: { agent: agentId },
        });
        return `Restored working file: ${filename}`;
      },
    );
  }

  async renameWorkingFile(
    agentId: string,
    from: string,
    to: string,
  ): Promise<ToolResult> {
    return this.workingFileAction(
      agentId,
      'rename_working_file',
      from,
      async (source, scope) => {
        // Both ends are confined to the working directory by resolveScopedKey.
        const destination = resolveScopedKey(scope.workingPrefix, to);
        await this.post('move', {
          source,
          destination,
          originators: { agent: agentId },
        });
        return `Renamed working file: ${from} → ${to}`;
      },
    );
  }

  // Assignment-scoped material handlers (public for testability).

  async listMaterialFiles(agentId: string): Promise<ToolResult> {
    try {
      const scope = await this.fetchScope(agentId);
      const list = scope.materials.map((m) => ({
        name: m.name,
        kind: m.key === null ? 'inline-text' : 'file',
      }));
      return ok(JSON.stringify(list, null, 2));
    } catch (e) {
      return ok(extractServerErrorMessage(e));
    }
  }

  async getMaterialFileProperties(
    agentId: string,
    filename: string,
  ): Promise<ToolResult> {
    try {
      const scope = await this.fetchScope(agentId);
      const material = this.findMaterial(scope, filename);
      if (!material) return ok(this.materialNotFound(filename));
      if (material.key === null) {
        return ok(
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
      return ok(JSON.stringify(props, null, 2));
    } catch (e) {
      return ok(extractServerErrorMessage(e));
    }
  }

  async readMaterialFile(
    agentId: string,
    filename: string,
  ): Promise<ToolResult> {
    try {
      const scope = await this.fetchScope(agentId);
      const material = this.findMaterial(scope, filename);
      if (!material) return ok(this.materialNotFound(filename));
      if (material.key === null) {
        return ok(material.inlineText ?? '');
      }
      const { content } = await this.post<{ content: string }>('read', {
        path: material.key,
      });
      return ok(content);
    } catch (e) {
      return ok(extractServerErrorMessage(e));
    }
  }

  // Private helpers

  /** Resolves the caller's storage scope for the current tool call. */
  private fetchScope(agentId: string): Promise<StorageScope> {
    return this.api.get<StorageScope>(
      `/internal/agent/${agentId}/storage-scope`,
    );
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

  private post<T>(action: string, body: unknown): Promise<T> {
    return this.api.post<T>(`/internal/storage/${action}`, body);
  }

  // Server registration

  private registerDescribeServer(server: McpServer): void {
    registerDescribeServer(
      server,
      storageToolDescriptions.describe_server,
      storagePrompts.describe_server,
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
    if (
      p.includes('/tasks/') &&
      p.includes('/completed') &&
      !p.includes('/assignments/')
    )
      return storagePrompts.describe_folder_task_completed;
    if (p.includes('/working'))
      return storagePrompts.describe_folder_assignment_working;
    if (p.includes('/assignments/') && p.includes('/completed'))
      return storagePrompts.describe_folder_assignment_completed;
    if (p.includes('/knowledge/') || p.endsWith('/knowledge'))
      return storagePrompts.describe_folder_knowledge;
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

  private registerGetWorkingFileSummary(server: McpServer): void {
    server.registerTool(
      'get_working_file_summary',
      {
        description: storageToolDescriptions.get_working_file_summary,
        inputSchema: {
          agentId: z.uuid().describe('The calling agent UUID.'),
          filename: z
            .string()
            .describe('Filename relative to your working directory.'),
        },
      },
      ({ agentId, filename }) => this.getWorkingFileSummary(agentId, filename),
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

  private registerCreateWorkingFile(server: McpServer): void {
    server.registerTool(
      'create_working_file',
      {
        description: storageToolDescriptions.create_working_file,
        inputSchema: {
          agentId: z.uuid().describe('The calling agent UUID.'),
          filename: z
            .string()
            .describe('Filename relative to your working directory.'),
          content: z.string().describe('The full content of the file.'),
          overwrite: z
            .boolean()
            .optional()
            .describe('Set true to replace an existing file entirely.'),
        },
      },
      ({ agentId, filename, content, overwrite }) =>
        this.createWorkingFile(agentId, filename, content, overwrite),
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
