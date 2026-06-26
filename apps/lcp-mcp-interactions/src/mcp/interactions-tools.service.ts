import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import axios from 'axios';
import { z } from 'zod';
import { AuditClientService } from '../audit/audit-client.service';
import { interactionPrompts } from '../interactions-prompts';

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

  constructor(
    private readonly audit: AuditClientService,
    config: ConfigService,
  ) {
    this.serverUrl = config.getOrThrow<string>('LCP_SERVER_URL');
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
    server.tool(
      'describe_server',
      'Returns an overview of the interactions service and its tools.',
      {},
      (): ToolResult => ok(interactionPrompts.describe_server),
    );
  }

  private registerListAvailableUsers(server: McpServer): void {
    server.tool(
      'list_available_users',
      'Lists the human users registered in the company along with their roles and knowledge domains.',
      {
        companyId: z.string().uuid().describe('The company UUID.'),
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
    server.tool(
      'list_available_roles',
      'Lists the agent roles defined in the company that can be consulted.',
      {
        companyId: z.string().uuid().describe('The company UUID.'),
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
    server.tool(
      'request_user_input',
      [
        'Pauses the current agent and submits a question to the relevant human users in the company.',
        'The agent will be automatically resumed once a user replies.',
        'Use this when you need information or a decision that only a human can provide.',
      ].join(' '),
      {
        agentId: z.string().uuid().describe('The calling agent UUID.'),
        companyId: z.string().uuid().describe('The company UUID.'),
        question: z.string().min(1).describe('The question to ask the user.'),
        context: z
          .string()
          .optional()
          .describe(
            'Optional context to help the user understand the request.',
          ),
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
    server.tool(
      'request_agent_consultation',
      [
        'Pauses the current agent and dispatches a consultation request to another agent role.',
        "The agent will be automatically resumed with the consulting agent's response once it completes.",
        'Use this when another role has specialist knowledge needed to proceed.',
      ].join(' '),
      {
        agentId: z.string().uuid().describe('The calling agent UUID.'),
        companyId: z.string().uuid().describe('The company UUID.'),
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
    server.tool(
      'complete_task',
      [
        'Marks the current agent task as complete with a final answer.',
        'Call this as your last action, after all work is done and any output files have been written.',
        'The finalAnswer should be a concise, human-readable summary of what was accomplished.',
      ].join(' '),
      {
        agentId: z.string().uuid().describe('The calling agent UUID.'),
        companyId: z.string().uuid().describe('The company UUID.'),
        finalAnswer: z
          .string()
          .min(1)
          .describe('A concise summary of the completed task and its outputs.'),
      },
      async ({ agentId, companyId, finalAnswer }): Promise<ToolResult> => {
        try {
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
}
