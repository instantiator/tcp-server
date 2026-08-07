import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolResult, extractServerErrorMessage, ok } from '@tcp/shared';
import { getReadOnlyMessage } from '../storage-prompts';
import { storageToolDescriptions } from '../storage-tool-descriptions';
import { resolveScopedKey } from './scoped-key';
import {
  FileEntry,
  FileProperties,
  StorageApiService,
  StorageScope,
} from './storage-api.service';

/** The working-directory inspect tools an agent keeps in a read-only scope. */
const READ_ONLY_WORKING_TOOLS = [
  'read_working_file',
  'list_working_files',
  'get_working_file_properties',
  'get_working_file_summary',
];

/** Zod schema fragment shared by every scoped tool that names one file. */
const AGENT_AND_FILENAME = {
  agentId: z.uuid().describe('The calling agent UUID.'),
  filename: z.string().describe('Filename relative to your working directory.'),
};

/**
 * The assignment-scoped working-file tier: the model supplies only a filename,
 * and the working-directory prefix is resolved server-side from the caller's
 * assignment — so an agent can only ever read and write inside its own working
 * area, and a qa-mode caller cannot write at all.
 *
 * The `agentId` field on these tools is injected server-side by
 * McpClientService and never supplied by the model.
 */
@Injectable()
export class WorkingFileToolsService {
  constructor(private readonly storage: StorageApiService) {}

  /** Registers this tier's tools on a fresh server instance. */
  register(server: McpServer): void {
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

    server.registerTool(
      'get_working_file_properties',
      {
        description: storageToolDescriptions.get_working_file_properties,
        inputSchema: AGENT_AND_FILENAME,
      },
      ({ agentId, filename }) =>
        this.getWorkingFileProperties(agentId, filename),
    );

    server.registerTool(
      'get_working_file_summary',
      {
        description: storageToolDescriptions.get_working_file_summary,
        inputSchema: AGENT_AND_FILENAME,
      },
      ({ agentId, filename }) => this.getWorkingFileSummary(agentId, filename),
    );

    server.registerTool(
      'read_working_file',
      {
        description: storageToolDescriptions.read_working_file,
        inputSchema: AGENT_AND_FILENAME,
      },
      ({ agentId, filename }) => this.readWorkingFile(agentId, filename),
    );

    server.registerTool(
      'create_working_file',
      {
        description: storageToolDescriptions.create_working_file,
        inputSchema: {
          ...AGENT_AND_FILENAME,
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

    server.registerTool(
      'append_working_file',
      {
        description: storageToolDescriptions.append_working_file,
        inputSchema: {
          ...AGENT_AND_FILENAME,
          content: z.string().describe('The text content to append.'),
        },
      },
      ({ agentId, filename, content }) =>
        this.appendWorkingFile(agentId, filename, content),
    );

    server.registerTool(
      'replace_in_working_file',
      {
        description: storageToolDescriptions.replace_in_working_file,
        inputSchema: {
          ...AGENT_AND_FILENAME,
          find: z
            .string()
            .describe('The literal string to find (all occurrences replaced).'),
          replace: z.string().describe('The replacement string.'),
        },
      },
      ({ agentId, filename, find, replace }) =>
        this.replaceInWorkingFile(agentId, filename, find, replace),
    );

    server.registerTool(
      'delete_working_file',
      {
        description: storageToolDescriptions.delete_working_file,
        inputSchema: AGENT_AND_FILENAME,
      },
      ({ agentId, filename }) => this.deleteWorkingFile(agentId, filename),
    );

    server.registerTool(
      'restore_working_file',
      {
        description: storageToolDescriptions.restore_working_file,
        inputSchema: AGENT_AND_FILENAME,
      },
      ({ agentId, filename }) => this.restoreWorkingFile(agentId, filename),
    );

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

  async listWorkingFiles(agentId: string): Promise<ToolResult> {
    try {
      const scope = await this.storage.fetchScope(agentId);
      const { entries } = await this.storage.post<{ entries: FileEntry[] }>(
        'list',
        { prefix: scope.workingPrefix },
      );
      return ok(JSON.stringify(entries, null, 2));
    } catch (e) {
      return ok(extractServerErrorMessage(e));
    }
  }

  async getWorkingFileProperties(
    agentId: string,
    filename: string,
  ): Promise<ToolResult> {
    return this.scopedRead(agentId, filename, async (key) => {
      const props = await this.storage.post<FileProperties>('properties', {
        path: key,
      });
      return JSON.stringify(props, null, 2);
    });
  }

  async getWorkingFileSummary(
    agentId: string,
    filename: string,
  ): Promise<ToolResult> {
    return this.scopedRead(agentId, filename, async (key) => {
      const summary = await this.storage.post<Record<string, unknown>>(
        'summary',
        { path: key },
      );
      return JSON.stringify(summary, null, 2);
    });
  }

  async readWorkingFile(
    agentId: string,
    filename: string,
  ): Promise<ToolResult> {
    return this.scopedRead(agentId, filename, async (key) => {
      const { content } = await this.storage.post<{ content: string }>('read', {
        path: key,
      });
      return content;
    });
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
        const props = await this.storage.post<FileProperties>('properties', {
          path: key,
        });
        if (props.exists && !overwrite) {
          return `Working file '${filename}' already exists. Set overwrite: true to replace it, or use append_working_file to add to it.`;
        }
        await this.storage.post('write', {
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
        const { created } = await this.storage.post<{ created: boolean }>(
          'append',
          { path: key, content, originators: { agent: agentId } },
        );
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
        const { count } = await this.storage.post<{ count: number }>(
          'replace',
          { path: key, find, replace, originators: { agent: agentId } },
        );
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
        await this.storage.post('delete', {
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
        await this.storage.post('restore', {
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
        await this.storage.post('move', {
          source,
          destination,
          originators: { agent: agentId },
        });
        return `Renamed working file: ${from} → ${to}`;
      },
    );
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
      const scope = await this.storage.fetchScope(agentId);
      if (scope.readOnly) {
        return ok(getReadOnlyMessage(tool, READ_ONLY_WORKING_TOOLS));
      }
      const key = resolveScopedKey(scope.workingPrefix, filename);
      return ok(await run(key, scope));
    } catch (e) {
      return ok(extractServerErrorMessage(e));
    }
  }

  /**
   * The read-side counterpart of {@link workingFileAction}: same scope
   * resolution and filename confinement, no read-only refusal — these tools
   * stay available to a qa-mode caller.
   */
  private async scopedRead(
    agentId: string,
    filename: string,
    run: (key: string) => Promise<string>,
  ): Promise<ToolResult> {
    try {
      const scope = await this.storage.fetchScope(agentId);
      const key = resolveScopedKey(scope.workingPrefix, filename);
      return ok(await run(key));
    } catch (e) {
      return ok(extractServerErrorMessage(e));
    }
  }
}
