import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import axios from 'axios';
import { z } from 'zod';
import { storagePrompts } from '../storage-prompts';
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

/** MCP tool result envelope — index signature satisfies the SDK's Zod-inferred type. */
interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
}

/**
 * Builds fresh {@link McpServer} instances pre-loaded with all storage tools.
 * A new server is created per request so state is never shared across sessions.
 * Tool handlers are public methods so integration tests can call them directly.
 *
 * All file-action logic (validation, soft-delete, content analysis, audit)
 * lives on `lcp-server` behind `/internal/storage/*` (see
 * docs/prompts/009.4 - doc type validations.md) — this service is a thin
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

    this.registerDescribeServer(server);
    this.registerDescribeFolder(server);
    this.registerListFiles(server);
    this.registerReadFile(server);
    this.registerWriteFile(server);
    this.registerDeleteFile(server);
    this.registerRestoreFile(server);
    this.registerSearchFiles(server);
    this.registerGetFileProperties(server);
    this.registerCopyFile(server);
    this.registerMoveFile(server);
    this.registerGetFileSummary(server);

    return server;
  }

  // Tool handlers (public for testability) — each proxies to lcp-server.

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

  async writeFile(
    path: string,
    content: string,
    overwrite = false,
    agentId?: string,
  ): Promise<ToolResult> {
    try {
      await this.post('write', {
        path,
        content,
        overwrite,
        originators: { agent: agentId ?? null },
      });
      return this.textResult(`Written: ${path}`);
    } catch (e) {
      return this.textResult(this.extractErrorMessage(e));
    }
  }

  async deleteFile(path: string, agentId?: string): Promise<ToolResult> {
    try {
      await this.post('delete', {
        path,
        originators: { agent: agentId ?? null },
      });
      return this.textResult(`Deleted: ${path} (restorable via restore_file)`);
    } catch (e) {
      return this.textResult(this.extractErrorMessage(e));
    }
  }

  async restoreFile(path: string, agentId?: string): Promise<ToolResult> {
    try {
      await this.post('restore', {
        path,
        originators: { agent: agentId ?? null },
      });
      return this.textResult(`Restored: ${path}`);
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

  async copyFile(
    source: string,
    destination: string,
    agentId?: string,
  ): Promise<ToolResult> {
    try {
      await this.post('copy', {
        source,
        destination,
        originators: { agent: agentId ?? null },
      });
      return this.textResult(`Copied: ${source} → ${destination}`);
    } catch (e) {
      return this.textResult(this.extractErrorMessage(e));
    }
  }

  async moveFile(
    source: string,
    destination: string,
    agentId?: string,
  ): Promise<ToolResult> {
    try {
      await this.post('move', {
        source,
        destination,
        originators: { agent: agentId ?? null },
      });
      return this.textResult(`Moved: ${source} → ${destination}`);
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

  private registerWriteFile(server: McpServer): void {
    server.registerTool(
      'write_file',
      {
        description: storageToolDescriptions.write_file,
        inputSchema: {
          path: z.string().describe('The object key to write.'),
          content: z.string().describe('The text content to write.'),
          overwrite: z
            .boolean()
            .optional()
            .describe('Replace an existing file (default: false).'),
          agentId: z.uuid().describe('The calling agent UUID.'),
          companyId: z.uuid().describe('The company UUID.'),
        },
      },
      ({ path, content, overwrite, agentId }) =>
        this.writeFile(path, content, overwrite ?? false, agentId),
    );
  }

  private registerDeleteFile(server: McpServer): void {
    server.registerTool(
      'delete_file',
      {
        description: storageToolDescriptions.delete_file,
        inputSchema: {
          path: z.string().describe('The object key to delete.'),
          agentId: z.uuid().describe('The calling agent UUID.'),
          companyId: z.uuid().describe('The company UUID.'),
        },
      },
      ({ path, agentId }) => this.deleteFile(path, agentId),
    );
  }

  private registerRestoreFile(server: McpServer): void {
    server.registerTool(
      'restore_file',
      {
        description: storageToolDescriptions.restore_file,
        inputSchema: {
          path: z.string().describe('The original object key to restore.'),
          agentId: z.uuid().describe('The calling agent UUID.'),
          companyId: z.uuid().describe('The company UUID.'),
        },
      },
      ({ path, agentId }) => this.restoreFile(path, agentId),
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

  private registerCopyFile(server: McpServer): void {
    server.registerTool(
      'copy_file',
      {
        description: storageToolDescriptions.copy_file,
        inputSchema: {
          source: z.string().describe('The source object key.'),
          destination: z.string().describe('The destination object key.'),
          agentId: z.uuid().describe('The calling agent UUID.'),
          companyId: z.uuid().describe('The company UUID.'),
        },
      },
      ({ source, destination, agentId }) =>
        this.copyFile(source, destination, agentId),
    );
  }

  private registerMoveFile(server: McpServer): void {
    server.registerTool(
      'move_file',
      {
        description: storageToolDescriptions.move_file,
        inputSchema: {
          source: z.string().describe('The source object key.'),
          destination: z.string().describe('The destination object key.'),
          agentId: z.uuid().describe('The calling agent UUID.'),
          companyId: z.uuid().describe('The company UUID.'),
        },
      },
      ({ source, destination, agentId }) =>
        this.moveFile(source, destination, agentId),
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
}
