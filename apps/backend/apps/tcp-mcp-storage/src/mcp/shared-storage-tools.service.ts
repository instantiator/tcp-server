import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolResult, extractServerErrorMessage, ok } from '@tcp/shared';
import { storagePrompts } from '../storage-prompts';
import { storageToolDescriptions } from '../storage-tool-descriptions';
import { resolveCompanyKey } from './scoped-key';
import {
  FileEntry,
  FileProperties,
  StorageApiService,
} from './storage-api.service';

/** Injected caller identity: hidden from the model, filled in by the agent runtime. */
const AGENT_ID = { agentId: z.uuid() };

/**
 * The read-only exploration tier: thin proxies over `/internal/storage/*` that
 * let an agent browse its company's storage by object key.
 *
 * Every path is resolved inside the caller's company folder
 * ({@link resolveCompanyKey}), so no other company's files are reachable.
 * Nothing here is assignment-scoped, and nothing here writes.
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
          ...AGENT_ID,
          path: z
            .string()
            .optional()
            .describe(
              'Path prefix to list under (default: all your company files).',
            ),
        },
      },
      ({ agentId, path }) => this.listFiles(agentId, path),
    );

    server.registerTool(
      'read_file',
      {
        description: storageToolDescriptions.read_file,
        inputSchema: {
          ...AGENT_ID,
          path: z.string().describe('The object key to read.'),
        },
      },
      ({ agentId, path }) => this.readFile(agentId, path),
    );

    server.registerTool(
      'search_files',
      {
        description: storageToolDescriptions.search_files,
        inputSchema: {
          ...AGENT_ID,
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
      ({ agentId, prefix, pattern }) =>
        this.searchFiles(agentId, prefix, pattern),
    );

    server.registerTool(
      'get_file_properties',
      {
        description: storageToolDescriptions.get_file_properties,
        inputSchema: {
          ...AGENT_ID,
          path: z.string().describe('The object key to inspect.'),
        },
      },
      ({ agentId, path }) => this.getFileProperties(agentId, path),
    );

    server.registerTool(
      'get_file_summary',
      {
        description: storageToolDescriptions.get_file_summary,
        inputSchema: {
          ...AGENT_ID,
          path: z.string().describe('The object key to summarise.'),
        },
      },
      ({ agentId, path }) => this.getFileSummary(agentId, path),
    );
  }

  async listFiles(agentId: string, prefix?: string): Promise<ToolResult> {
    return this.inCompany(agentId, prefix, async (key) => {
      const { entries } = await this.storage.post<{ entries: FileEntry[] }>(
        'list',
        { prefix: key },
      );
      return JSON.stringify(entries, null, 2);
    });
  }

  async readFile(agentId: string, path: string): Promise<ToolResult> {
    return this.inCompany(agentId, path, async (key) => {
      const { content } = await this.storage.post<{ content: string }>('read', {
        path: key,
      });
      return content;
    });
  }

  async searchFiles(
    agentId: string,
    prefix?: string,
    pattern?: string,
  ): Promise<ToolResult> {
    return this.inCompany(agentId, prefix, async (key) => {
      const { entries } = await this.storage.post<{ entries: FileEntry[] }>(
        'search',
        { prefix: key, pattern },
      );
      return JSON.stringify(entries, null, 2);
    });
  }

  async getFileProperties(agentId: string, path: string): Promise<ToolResult> {
    return this.inCompany(agentId, path, async (key) => {
      const props = await this.storage.post<FileProperties>('properties', {
        path: key,
      });
      return JSON.stringify(props, null, 2);
    });
  }

  async getFileSummary(agentId: string, path: string): Promise<ToolResult> {
    return this.inCompany(agentId, path, async (key) => {
      const summary = await this.storage.post<Record<string, unknown>>(
        'summary',
        { path: key },
      );
      return JSON.stringify(summary, null, 2);
    });
  }

  /**
   * Resolves `path` inside the caller's company folder and runs `action` on
   * the resulting key. Any failure — a bad path, a missing file — is relayed
   * to the model as text, as the other storage tools do.
   */
  private async inCompany(
    agentId: string,
    path: string | undefined,
    action: (key: string) => Promise<string>,
  ): Promise<ToolResult> {
    try {
      const { companyPrefix } = await this.storage.fetchScope(agentId);
      return ok(await action(resolveCompanyKey(companyPrefix, path)));
    } catch (e) {
      return ok(extractServerErrorMessage(e));
    }
  }

  /** Explains what a folder in the ADR-007 hierarchy is for, from its path shape. */
  private describeFolder(p: string): string {
    // First: a draft under `working/resources/` is still a resource.
    if (p.includes('/resources/') || p.endsWith('/resources'))
      return storagePrompts.describe_folder_resources;
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
