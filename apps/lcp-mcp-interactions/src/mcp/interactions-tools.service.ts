import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import axios, { AxiosError } from 'axios';
import { z } from 'zod';
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
 * Relays a 4xx server error's message to the model as a normal (non-error)
 * tool result so it can self-correct and retry; falls back to `fallback` for
 * 5xx/transport errors it cannot act on. Mirrors lcp-mcp-tasks' `relayOrError`.
 */
function relay4xxOrError(e: unknown, fallback: string): ToolResult {
  const axiosErr = e as AxiosError<{ message?: string | string[] }>;
  const status = axiosErr.response?.status;
  if (status && status >= 400 && status < 500) {
    const raw = axiosErr.response?.data?.message;
    const message = Array.isArray(raw) ? raw.join('; ') : raw;
    if (message) return ok(message);
  }
  return err(fallback);
}

/**
 * Builds fresh {@link McpServer} instances pre-loaded with real interaction tools.
 * A new server is created per request so state is never shared across sessions.
 *
 * All state-mutating operations (`request_user_input`,
 * `request_agent_consultation`) delegate to lcp-server's internal endpoints,
 * which handle all database writes and BullMQ job dispatch. Assignment
 * completion moved to the lcp-mcp-tasks service (`complete_assignment`) in
 * task-orchestration part 5.
 */
@Injectable()
export class InteractionsToolsService {
  private readonly logger = new Logger(InteractionsToolsService.name);
  private readonly serverUrl: string;
  private readonly apiKey: string;

  constructor(config: ConfigService) {
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
    this.registerListAvailableContacts(server);
    this.registerRequestUserInput(server);
    this.registerRequestAgentConsultation(server);

    return server;
  }

  private registerDescribeServer(server: McpServer): void {
    server.registerTool(
      'describe_server',
      { description: interactionToolDescriptions.describe_server },
      (): ToolResult => ok(interactionPrompts.describe_server),
    );
  }

  /**
   * Registers a read-only tool listing company users and/or agent roles
   * (`kind`), proxying a GET to lcp-server's internal company sub-collection
   * endpoint (`/internal/company/{id}/{collection}`) for each requested
   * collection. A single collection returns its raw JSON array directly
   * (matching the pre-merge single-purpose tools' output shape); `kind:
   * 'both'` returns `{ users, roles }`, each independently falling back to
   * an error message if that collection's fetch fails — one collection
   * failing doesn't hide the other's data.
   */
  private registerListAvailableContacts(server: McpServer): void {
    server.registerTool(
      'list_available_contacts',
      {
        description: interactionToolDescriptions.list_available_contacts,
        inputSchema: {
          companyId: z.uuid().describe('The company UUID.'),
          kind: z
            .string()
            .optional()
            .describe(
              'Which contacts to list: `users`, `roles`, or `both` (default, case-insensitive).',
            ),
        },
      },
      async ({ companyId, kind }): Promise<ToolResult> => {
        const normalisedKind = kind?.trim().toLowerCase();
        const collections: Array<'users' | 'roles'> =
          normalisedKind === 'users' || normalisedKind === 'roles'
            ? [normalisedKind]
            : ['users', 'roles'];

        const fetched = await Promise.all(
          collections.map((collection) =>
            this.fetchCompanyCollection(companyId, collection),
          ),
        );

        if (collections.length === 1) {
          const [only] = fetched;
          return only.ok
            ? ok(JSON.stringify(only.data, null, 2))
            : err(only.errorPrompt);
        }

        const combined: Record<string, unknown> = {};
        for (const [i, collection] of collections.entries()) {
          const result = fetched[i];
          combined[collection] = result.ok
            ? result.data
            : { error: result.errorPrompt };
        }
        return ok(JSON.stringify(combined, null, 2));
      },
    );
  }

  /** Fetches one company sub-collection, reporting success/failure per-collection. */
  private async fetchCompanyCollection(
    companyId: string,
    collection: 'users' | 'roles',
  ): Promise<{ ok: true; data: unknown } | { ok: false; errorPrompt: string }> {
    try {
      const res = await axios.get<unknown[]>(
        `${this.serverUrl}/internal/company/${companyId}/${collection}`,
        { headers: { 'X-Internal-Api-Key': this.apiKey } },
      );
      return { ok: true, data: res.data };
    } catch (e) {
      this.logger.warn(
        `list_available_contacts (${collection}) failed: ${String(e)}`,
      );
      return {
        ok: false,
        errorPrompt:
          collection === 'users'
            ? interactionPrompts.error_list_users
            : interactionPrompts.error_list_roles,
      };
    }
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
          userIds: z
            .array(z.uuid())
            .min(1)
            .optional()
            .describe(
              'Optional company user ids (from list_available_contacts) to target this question to. Omit to auto-route based on the question.',
            ),
        },
      },
      async ({
        agentId,
        companyId,
        question,
        context,
        userIds,
      }): Promise<ToolResult> => {
        try {
          const res = await axios.post<{ slug: string }>(
            `${this.serverUrl}/internal/pause`,
            {
              type: 'user_input',
              agentId,
              companyId,
              question,
              context,
              userIds,
            },
            { headers: { 'X-Internal-Api-Key': this.apiKey } },
          );

          // Report the conversation slug back to the agent so it knows the
          // request was submitted; the agent loop pauses here until a reply
          // resumes it.
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
          companyId: z
            .uuid()
            .optional()
            .describe('The company UUID. Provide this or companySlug.'),
          companySlug: z
            .string()
            .min(1)
            .optional()
            .describe('The company slug, as an alternative to companyId.'),
          roleId: z
            .uuid()
            .optional()
            .describe(
              'The id of the role to consult — get it from list_available_contacts. Provide this or roleSlug.',
            ),
          roleSlug: z
            .string()
            .min(1)
            .optional()
            .describe(
              'The slug of the role to consult, as an alternative to roleId (unique within the company, not globally).',
            ),
          roleName: z
            .string()
            .min(1)
            .optional()
            .describe(
              'Optional human-readable role name, used only for friendlier logging if the consultation fails.',
            ),
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
        companySlug,
        roleId,
        roleSlug,
        roleName,
        question,
        context,
      }): Promise<ToolResult> => {
        try {
          // Ask lcp-server to pause this agent and dispatch a new consulting
          // agent for the resolved role — it looks the role up by id or slug
          // (scoped to the company either way, so it's unambiguous even when
          // multiple roles share a name), starts the consulting agent, and
          // records the PendingConsultation link between them.
          const res = await axios.post<{
            consultationId: string;
            roleName: string;
          }>(
            `${this.serverUrl}/internal/pause`,
            {
              type: 'agent_consultation',
              agentId,
              companyId,
              companySlug,
              roleId,
              roleSlug,
              roleName,
              question,
              context,
            },
            { headers: { 'X-Internal-Api-Key': this.apiKey } },
          );

          // Report the resolved role name (from the server, not the caller's
          // possibly-stale label) and consultation id; the agent loop pauses
          // here until the consulting agent completes.
          const { consultationId, roleName: resolvedRoleName } = res.data;
          return ok(
            interpolate(interactionPrompts.paused_consultation, {
              roleName: resolvedRoleName,
              consultationId,
            }),
          );
        } catch (e) {
          this.logger.error(`request_agent_consultation failed: ${String(e)}`);
          // A 4xx carries a corrective message (e.g. an unknown target role,
          // naming the valid roles) — relay it verbatim as a normal tool result
          // so the model can retry with a valid value, rather than a generic
          // failure it can't act on.
          return relay4xxOrError(
            e,
            interpolate(interactionPrompts.error_consultation, {
              roleName: roleName ?? roleId ?? roleSlug ?? 'unknown role',
            }),
          );
        }
      },
    );
  }
}
