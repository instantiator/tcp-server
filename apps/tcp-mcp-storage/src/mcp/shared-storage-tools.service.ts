import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolResult, extractServerErrorMessage, ok } from '@tcp/shared';
import { storagePrompts } from '../storage-prompts';
import { storageToolDescriptions } from '../storage-tool-descriptions';
import {
  FileEntry,
  FileProperties,
  StorageApiService,
} from './storage-api.service';

/**
 * The read-only exploration tier: thin proxies over `/internal/storage/*` that
 * let an agent browse shared storage by full object key.
 *
 * Nothing here is assignment-scoped — these tools see the whole bucket, and
 * cannot write to any of it.
 */
@Injectable()
export class SharedStorageToolsService {
  constructor(private readonly storage: StorageApiService) {}

  /** Registers this tier's tools on a fresh server instance. */
  register(server: McpServer): void {
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

    server.registerTool(
      'read_file',
      {
        description: storageToolDescriptions.read_file,
        inputSchema: { path: z.string().describe('The object key to read.') },
      },
      ({ path }) => this.readFile(path),
    );

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

  async listFiles(prefix?: string): Promise<ToolResult> {
    const { entries } = await this.storage.post<{ entries: FileEntry[] }>(
      'list',
      { prefix },
    );
    return ok(JSON.stringify(entries, null, 2));
  }

  async readFile(path: string): Promise<ToolResult> {
    try {
      const { content } = await this.storage.post<{ content: string }>('read', {
        path,
      });
      return ok(content);
    } catch (e) {
      return ok(extractServerErrorMessage(e));
    }
  }

  async searchFiles(prefix?: string, pattern?: string): Promise<ToolResult> {
    const { entries } = await this.storage.post<{ entries: FileEntry[] }>(
      'search',
      { prefix, pattern },
    );
    return ok(JSON.stringify(entries, null, 2));
  }

  async getFileProperties(path: string): Promise<ToolResult> {
    try {
      const props = await this.storage.post<FileProperties>('properties', {
        path,
      });
      return ok(JSON.stringify(props, null, 2));
    } catch (e) {
      return ok(extractServerErrorMessage(e));
    }
  }

  async getFileSummary(path: string): Promise<ToolResult> {
    try {
      const summary = await this.storage.post<Record<string, unknown>>(
        'summary',
        { path },
      );
      return ok(JSON.stringify(summary, null, 2));
    } catch (e) {
      return ok(extractServerErrorMessage(e));
    }
  }

  /** Explains what a folder in the ADR-007 hierarchy is for, from its path shape. */
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
}
