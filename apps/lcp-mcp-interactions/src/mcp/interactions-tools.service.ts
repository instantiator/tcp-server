import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import axios from 'axios';
import { z } from 'zod';
import { AuditClientService } from '@lcp/shared';
import { interactionPrompts } from '../interactions-prompts';
import { interactionToolDescriptions } from '../interactions-tool-descriptions';

/** Replaces `{{key}}` placeholders in a template string. */
function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (_, key: string) => vars[key] ?? '',
  );
}

/** MCP tool result envelope — index signature satisfies the SDK's Zod-inferred type. */
interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
}

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function err(text: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${text}` }] };
}

/**
 * Builds fresh {@link McpServer} instances pre-loaded with real interaction tools.
 * A new server is created per request so state is never shared across sessions.
 *
 * All state-mutating operations (`request_user_input`, `request_agent_consultation`,
 * `complete_task`) delegate to lcp-server's internal endpoints, which handle
 * all database writes and BullMQ job dispatch.
 */
@Injectable()
export class InteractionsToolsService {
  private readonly logger = new Logger(InteractionsToolsService.name);
  private readonly serverUrl: string;
  private readonly apiKey: string;

  private readonly storageUrl: string;

  constructor(
    private readonly audit: AuditClientService,
    config: ConfigService,
  ) {
    this.serverUrl = config.getOrThrow<string>('LCP_SERVER_URL');
    this.storageUrl = config.getOrThrow<string>('LCP_STORAGE_URL');
    this.apiKey = config.getOrThrow<string>('INTERNAL_API_KEY');
  }

  /** Creates and returns a configured McpServer with all interaction tools registered. */
  createServer(): McpServer {
    const server = new McpServer({
      name: 'lcp-mcp-interactions',
      version: '1.0.0',
    });

    this.registerDescribeServer(server);
    this.registerListAvailableUsers(server);
    this.registerListAvailableRoles(server);
    this.registerRequestUserInput(server);
    this.registerRequestAgentConsultation(server);
    this.registerCompleteTask(server);

    return server;
  }

  private registerDescribeServer(server: McpServer): void {
    server.registerTool(
      'describe_server',
      { description: interactionToolDescriptions.describe_server },
      (): ToolResult => ok(interactionPrompts.describe_server),
    );
  }

  private registerListAvailableUsers(server: McpServer): void {
    server.registerTool(
      'list_available_users',
      {
        description: interactionToolDescriptions.list_available_users,
        inputSchema: {
          companyId: z.uuid().describe('The company UUID.'),
        },
      },
      async ({ companyId }): Promise<ToolResult> => {
        try {
          const res = await axios.get<unknown[]>(
            `${this.serverUrl}/api/company/${companyId}/users`,
            { headers: { Authorization: `Bearer internal` } },
          );
          return ok(JSON.stringify(res.data, null, 2));
        } catch (e) {
          this.logger.warn(`list_available_users failed: ${String(e)}`);
          return err(interactionPrompts.error_list_users);
        }
      },
    );
  }

  private registerListAvailableRoles(server: McpServer): void {
    server.registerTool(
      'list_available_roles',
      {
        description: interactionToolDescriptions.list_available_roles,
        inputSchema: {
          companyId: z.uuid().describe('The company UUID.'),
        },
      },
      async ({ companyId }): Promise<ToolResult> => {
        try {
          const res = await axios.get<unknown[]>(
            `${this.serverUrl}/api/roles?companyId=${companyId}`,
            { headers: { Authorization: `Bearer internal` } },
          );
          return ok(JSON.stringify(res.data, null, 2));
        } catch (e) {
          this.logger.warn(`list_available_roles failed: ${String(e)}`);
          return err(interactionPrompts.error_list_roles);
        }
      },
    );
  }

  private registerRequestUserInput(server: McpServer): void {
    server.registerTool(
      'request_user_input',
      {
        description: interactionToolDescriptions.request_user_input,
        inputSchema: {
          agentId: z.uuid().describe('The calling agent UUID.'),
          companyId: z.uuid().describe('The company UUID.'),
          question: z.string().min(1).describe('The question to ask the user.'),
          context: z
            .string()
            .optional()
            .describe(
              'Optional context to help the user understand the request.',
            ),
        },
      },
      async ({
        agentId,
        companyId,
        question,
        context,
      }): Promise<ToolResult> => {
        try {
          const res = await axios.post<{ slug: string }>(
            `${this.serverUrl}/internal/pause`,
            { type: 'user_input', agentId, companyId, question, context },
            { headers: { 'X-Internal-Api-Key': this.apiKey } },
          );
          const { slug } = res.data;
          return ok(
            interpolate(interactionPrompts.paused_user_input, { slug }),
          );
        } catch (e) {
          this.logger.error(`request_user_input failed: ${String(e)}`);
          return err(interactionPrompts.error_user_input);
        }
      },
    );
  }

  private registerRequestAgentConsultation(server: McpServer): void {
    server.registerTool(
      'request_agent_consultation',
      {
        description: interactionToolDescriptions.request_agent_consultation,
        inputSchema: {
          agentId: z.uuid().describe('The calling agent UUID.'),
          companyId: z.uuid().describe('The company UUID.'),
          roleName: z
            .string()
            .min(1)
            .describe('The name of the role to consult.'),
          question: z
            .string()
            .min(1)
            .describe('The question to pose to the consulting agent.'),
          context: z
            .string()
            .optional()
            .describe('Optional context for the consultation.'),
        },
      },
      async ({
        agentId,
        companyId,
        roleName,
        question,
        context,
      }): Promise<ToolResult> => {
        try {
          const res = await axios.post<{ consultationId: string }>(
            `${this.serverUrl}/internal/pause`,
            {
              type: 'agent_consultation',
              agentId,
              companyId,
              roleName,
              question,
              context,
            },
            { headers: { 'X-Internal-Api-Key': this.apiKey } },
          );
          const { consultationId } = res.data;
          return ok(
            interpolate(interactionPrompts.paused_consultation, {
              roleName,
              consultationId,
            }),
          );
        } catch (e) {
          this.logger.error(`request_agent_consultation failed: ${String(e)}`);
          return err(
            interpolate(interactionPrompts.error_consultation, { roleName }),
          );
        }
      },
    );
  }

  private registerCompleteTask(server: McpServer): void {
    server.registerTool(
      'complete_task',
      {
        description: interactionToolDescriptions.complete_task,
        inputSchema: {
          agentId: z.uuid().describe('The calling agent UUID.'),
          companyId: z.uuid().describe('The company UUID.'),
          finalAnswer: z
            .string()
            .min(1)
            .describe(
              'A concise summary of the completed task and its outputs.',
            ),
          outputFiles: z
            .array(z.string().min(1))
            .optional()
            .describe(
              'Paths in shared storage that this task produced or references as output. Each will be verified to exist.',
            ),
        },
      },
      async ({
        agentId,
        companyId,
        finalAnswer,
        outputFiles,
      }): Promise<ToolResult> => {
        try {
          // File existence validation — only if the agent listed output files
          if (outputFiles && outputFiles.length > 0) {
            const missing = await this.checkMissingFiles(outputFiles);
            if (missing.length > 0) {
              const changes = await this.fetchStorageChanges(agentId);
              return ok(this.buildMissingFilesPrompt(missing, changes));
            }
          }

          await axios.post(
            `${this.serverUrl}/internal/agent/${agentId}/complete`,
            { output: finalAnswer },
            { headers: { 'X-Internal-Api-Key': this.apiKey } },
          );
          this.audit.record(companyId, 'agent', agentId, 'state_change', {
            newStatus: 'completed',
            source: 'complete_task',
          });
          return ok(interactionPrompts.task_complete);
        } catch (e) {
          this.logger.error(
            `complete_task failed for agent ${agentId}: ${String(e)}`,
          );
          return err(interactionPrompts.error_complete_task);
        }
      },
    );
  }

  /** Returns paths from `outputFiles` that do not exist in shared storage. */
  private async checkMissingFiles(paths: string[]): Promise<string[]> {
    try {
      const params = new URLSearchParams(paths.map((p) => ['path', p]));
      const res = await axios.get<{ missing: string[] }>(
        `${this.storageUrl}/files/exists?${params.toString()}`,
        { headers: { 'X-Internal-Api-Key': this.apiKey } },
      );
      return res.data.missing;
    } catch (e) {
      this.logger.warn(`File existence check failed: ${String(e)}`);
      // Fail open — if the storage service is unreachable, allow completion
      return [];
    }
  }

  /** Fetches the storage change tracker for the given agent from lcp-server. */
  private async fetchStorageChanges(agentId: string): Promise<{
    created: string[];
    modified: string[];
  }> {
    try {
      const res = await axios.get<{
        storageChanges?: {
          created?: string[];
          modified?: string[];
        } | null;
      }>(`${this.serverUrl}/internal/agent/${agentId}`, {
        headers: { 'X-Internal-Api-Key': this.apiKey },
      });
      const sc = res.data.storageChanges;
      return {
        created: sc?.created ?? [],
        modified: sc?.modified ?? [],
      };
    } catch {
      return { created: [], modified: [] };
    }
  }

  /** Builds the canned error prompt for missing output files. */
  private buildMissingFilesPrompt(
    missing: string[],
    changes: { created: string[]; modified: string[] },
  ): string {
    const missingList = missing.map((p) => `- ${p}`).join('\n');
    const created = changes.created.length
      ? changes.created.join(', ')
      : '(none)';
    const modified = changes.modified.length
      ? changes.modified.join(', ')
      : '(none)';
    return interpolate(interactionPrompts.missing_output_files, {
      missingList,
      created,
      modified,
    });
  }
}
