import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import axios, { AxiosError } from 'axios';
import { z } from 'zod';
import {
  AuditClientService,
  TcpAssignmentMode,
  MODE_PROMPTS,
  requiredToolForMode,
} from '@lcp/shared';
import { taskPrompts } from '../tasks-prompts';
import { taskToolDescriptions } from '../tasks-tool-descriptions';

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

/** The subset of an assignment the tool handlers need for mode-gating and proxying. */
interface CallerAssignment {
  id: string;
  mode: TcpAssignmentMode;
  taskId: string | null;
  targetAssignmentId: string | null;
}

/**
 * Zod shape for an `{ type, value }` artifact naming your own working file or
 * an assignment's own expected output — used for `expected` (create_plan) and
 * `prepared` (complete_assignment). The server does the actual validation
 * (and accepts near-miss synonyms, e.g. `working-file`, `path`) so this
 * `.describe()` only needs to state the two values agents should aim for.
 */
const workingArtifactSchema = z.object({
  type: z
    .string()
    .describe(
      'Either `file` (a filename in your working directory) or `text` (literal text).',
    ),
  value: z
    .string()
    .describe(
      'The filename (for type `file`) or the literal text (for type `text`).',
    ),
});

/**
 * Zod shape for an `{ type, value }` material handed to a plan step: either
 * an uploaded task material, a prior step's promoted output, or literal text.
 * Kept distinct from {@link workingArtifactSchema} because a planner must be
 * able to name both file sources at once, unlike a working artifact.
 */
const materialArtifactSchema = z.object({
  type: z
    .string()
    .describe(
      "One of `material-file` (an uploaded task material), `completed-file` (an earlier step's promoted output), or `text` (literal text).",
    ),
  value: z
    .string()
    .describe(
      'The filename (for type `material-file`/`completed-file`) or the literal text (for type `text`).',
    ),
});

/**
 * Builds fresh {@link McpServer} instances pre-loaded with the mode-gated task
 * tools. A new server is created per request so state is never shared across
 * sessions.
 *
 * State transitions live in lcp-server (which owns the DB and StorageService);
 * this service is a thin proxy + presentation layer, exactly like
 * lcp-mcp-storage and lcp-mcp-interactions. Each handler resolves the caller's
 * assignment (`GET /internal/agent/:id/assignment`) to mode-gate the tool,
 * then proxies to the matching internal endpoint. Validation/gate errors are
 * relayed verbatim so the model can correct itself.
 */
@Injectable()
export class TasksToolsService {
  private readonly logger = new Logger(TasksToolsService.name);
  private readonly serverUrl: string;
  private readonly apiKey: string;

  constructor(
    private readonly audit: AuditClientService,
    config: ConfigService,
  ) {
    this.serverUrl = config.getOrThrow<string>('LCP_SERVER_URL');
    this.apiKey = config.getOrThrow<string>('INTERNAL_API_KEY');
  }

  /** Creates and returns a configured McpServer with all task tools registered. */
  createServer(): McpServer {
    const server = new McpServer({ name: 'lcp-mcp-tasks', version: '1.0.0' });
    this.registerDescribeServer(server);
    this.registerCreatePlan(server);
    this.registerCompleteAssignment(server);
    this.registerAssureAssignment(server);
    return server;
  }

  private registerDescribeServer(server: McpServer): void {
    server.registerTool(
      'describe_server',
      {
        description: taskToolDescriptions.describe_server,
        inputSchema: {
          // Injected server-side by McpClientService; never supplied by the LLM.
          // Present so describe_server can tailor its text to the caller's mode.
          agentId: z.uuid().optional().describe('The calling agent UUID.'),
        },
      },
      async ({ agentId }): Promise<ToolResult> => {
        const mode = agentId
          ? (await this.tryFetchAssignment(agentId))?.mode
          : undefined;
        return ok(this.buildDescription(mode));
      },
    );
  }

  /**
   * Assembles the describe_server text: static framing plus the live
   * {@link MODE_PROMPTS} for each mode (embedded so the tool description and
   * the agent prompt can never drift), tailored to the caller's mode when known.
   */
  private buildDescription(mode: TcpAssignmentMode | undefined): string {
    const modeNote = mode
      ? interpolate(taskPrompts.current_mode, {
          mode,
          tool: requiredToolForMode(mode).join(', '),
        })
      : '';
    return [
      taskPrompts.describe_header,
      modeNote,
      `### Plan mode — create_plan\n\n${MODE_PROMPTS.plan}`,
      `### Implement mode — complete_assignment\n\n${MODE_PROMPTS.implement}`,
      `### QA mode — assure_assignment\n\n${MODE_PROMPTS.qa}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private registerCreatePlan(server: McpServer): void {
    server.registerTool(
      'create_plan',
      {
        description: taskToolDescriptions.create_plan,
        inputSchema: {
          agentId: z.uuid().describe('The calling agent UUID.'),
          companyId: z.uuid().describe('The company UUID.'),
          assignments: z
            .array(
              z.object({
                prompt: z
                  .string()
                  .min(1)
                  .describe('The instructions for this assignment.'),
                role: z
                  .string()
                  .min(1)
                  .describe('The role id or slug that must carry it out.'),
                expected: z
                  .array(workingArtifactSchema)
                  .describe('The outputs this assignment must produce.'),
                materials: z
                  .array(materialArtifactSchema)
                  .optional()
                  .describe('Optional inputs handed to this assignment.'),
              }),
            )
            .min(1)
            .describe('The ordered list of assignments making up the plan.'),
        },
      },
      async ({ agentId, companyId, assignments }): Promise<ToolResult> => {
        const caller = await this.tryFetchAssignment(agentId);
        if (!caller) return err(taskPrompts.error_no_assignment);
        if (caller.mode !== 'plan') return this.wrongMode(caller.mode);

        try {
          const res = await axios.post<{ created: number }>(
            `${this.serverUrl}/internal/task/${caller.taskId}/plan`,
            { agentId, assignments },
            { headers: { 'X-Internal-Api-Key': this.apiKey } },
          );
          this.audit.record(companyId, 'agent', agentId, 'state_change', {
            source: 'create_plan',
            created: res.data.created,
          });
          return ok(
            interpolate(taskPrompts.plan_created, {
              count: String(res.data.created),
            }),
          );
        } catch (e) {
          return this.relayOrError(
            e,
            'create_plan',
            taskPrompts.error_create_plan,
          );
        }
      },
    );
  }

  private registerCompleteAssignment(server: McpServer): void {
    server.registerTool(
      'complete_assignment',
      {
        description: taskToolDescriptions.complete_assignment,
        inputSchema: {
          agentId: z.uuid().describe('The calling agent UUID.'),
          companyId: z.uuid().describe('The company UUID.'),
          summary: z
            .string()
            .min(1)
            .describe('A concise summary of the completed assignment.'),
          prepared: z
            .array(workingArtifactSchema)
            .describe('The artifacts you prepared for review.'),
        },
      },
      async ({
        agentId,
        companyId,
        summary,
        prepared,
      }): Promise<ToolResult> => {
        const caller = await this.tryFetchAssignment(agentId);
        if (!caller) return err(taskPrompts.error_no_assignment);
        if (
          caller.mode !== 'implement' &&
          caller.mode !== 'consultee' &&
          caller.mode !== 'finalise'
        )
          return this.wrongMode(caller.mode);

        try {
          await axios.post(
            `${this.serverUrl}/internal/assignment/${caller.id}/complete`,
            { agentId, summary, prepared: prepared ?? [] },
            { headers: { 'X-Internal-Api-Key': this.apiKey } },
          );
          this.audit.record(companyId, 'agent', agentId, 'state_change', {
            source: 'complete_assignment',
          });
          return ok(taskPrompts.assignment_completed);
        } catch (e) {
          // A 422 gate failure comes back as a normal tool result (relayed
          // verbatim) so the model can correct itself and call again.
          return this.relayOrError(
            e,
            'complete_assignment',
            taskPrompts.error_complete_assignment,
          );
        }
      },
    );
  }

  private registerAssureAssignment(server: McpServer): void {
    server.registerTool(
      'assure_assignment',
      {
        description: taskToolDescriptions.assure_assignment,
        inputSchema: {
          agentId: z.uuid().describe('The calling agent UUID.'),
          companyId: z.uuid().describe('The company UUID.'),
          qa: z
            .string()
            .describe('Your verdict: `accept` or `reject` (case-insensitive).'),
          feedback: z
            .string()
            .optional()
            .describe('Actionable feedback — required when rejecting.'),
        },
      },
      async ({ agentId, companyId, qa, feedback }): Promise<ToolResult> => {
        const caller = await this.tryFetchAssignment(agentId);
        if (!caller) return err(taskPrompts.error_no_assignment);
        if (caller.mode !== 'qa') return this.wrongMode(caller.mode);

        // Fold case/whitespace here too (not just server-side) so the local
        // verdict text and audit record match what actually gets stored.
        const verdict = qa.trim().toLowerCase();

        try {
          await axios.post(
            `${this.serverUrl}/internal/assignment/${caller.targetAssignmentId}/assure`,
            { agentId, qa: verdict, feedback },
            { headers: { 'X-Internal-Api-Key': this.apiKey } },
          );
          this.audit.record(companyId, 'agent', agentId, 'state_change', {
            source: 'assure_assignment',
            verdict,
          });
          return ok(
            interpolate(taskPrompts.assignment_assured, {
              verdict: verdict === 'accept' ? 'accepted' : 'rejected',
            }),
          );
        } catch (e) {
          return this.relayOrError(
            e,
            'assure_assignment',
            taskPrompts.error_assure_assignment,
          );
        }
      },
    );
  }

  /** Resolves the caller's assignment for mode-gating; returns null on failure. */
  private async tryFetchAssignment(
    agentId: string,
  ): Promise<CallerAssignment | null> {
    try {
      const res = await axios.get<{ assignment: CallerAssignment }>(
        `${this.serverUrl}/internal/agent/${agentId}/assignment`,
        { headers: { 'X-Internal-Api-Key': this.apiKey } },
      );
      return res.data.assignment;
    } catch (e) {
      this.logger.warn(
        `Could not resolve assignment for agent ${agentId}: ${String(e)}`,
      );
      return null;
    }
  }

  /** The mode-mismatch error, naming the tool the caller should use instead. */
  private wrongMode(mode: TcpAssignmentMode): ToolResult {
    return err(
      interpolate(taskPrompts.error_wrong_mode, {
        mode,
        tool: requiredToolForMode(mode).join(', '),
      }),
    );
  }

  /**
   * A 4xx from an internal endpoint carries a corrective message written for
   * the LLM — relay it verbatim as a normal tool result so the model can fix
   * its call. Anything else (5xx, network) returns the generic fallback.
   */
  private relayOrError(e: unknown, tool: string, fallback: string): ToolResult {
    const axiosErr = e as AxiosError<{ message?: string | string[] }>;
    const status = axiosErr.response?.status;
    if (status && status >= 400 && status < 500) {
      const raw = axiosErr.response?.data?.message;
      const message = Array.isArray(raw) ? raw.join('; ') : raw;
      if (message) return ok(message);
    }
    this.logger.error(`${tool} failed: ${String(e)}`);
    return err(fallback);
  }
}
