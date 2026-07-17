import type { LcpAgent, LcpAssignment, LcpRole, LcpTask } from '@lcp/shared';
import {
  agentHeading,
  ASSIGNMENT_COMPLETE_LABEL,
  JsonDeltaFormatter,
  LogHeadingTracker,
  parseClockTime,
  shortId,
} from '../core/agent-log-format';
import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest, ApiOptions } from '../core/api';
import { createRenderer } from '../core/render';
import { parseSseBuffer } from '../core/sse';
import { readSseStream } from '../core/sse-reader';
import { wrapText } from '../core/text-wrap';
import { runCommand } from '../core/run-command';
import { resolveSession, TokenManager } from '../auth/token';

export interface EavesdropCmdOpts {
  agentId?: string;
  assignmentId?: string;
  taskId?: string;
  showHistory?: boolean;
  tail?: boolean;
}

/** Minimal shape of an audit row, as returned by the `.../history` endpoints. */
interface AuditRow {
  timestamp: string;
  eventType: string;
  agentId?: string | null;
  payload?: Record<string, unknown>;
}

/** Identifies the working agent behind one assignment, for the heading block and short-id prefix. */
interface AgentContext {
  agentId: string;
  assignmentId: string;
  assignmentRole: string;
  roleId: string;
  roleSlug: string;
}

/** A role's display name/slug — all `buildAgentContext`/`fetchRole` need. */
interface RoleInfo {
  name: string;
  slug: string;
}

const TERMINAL_AGENT_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_ASSIGNMENT_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);
const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

/** `hh:mm:ss` from an audit row's timestamp, or a placeholder if it doesn't parse. */
function formatTimestamp(timestamp: string): string {
  return parseClockTime(timestamp) ?? '--:--:--';
}

/** Fetches one role's name/slug (for the heading block and short-id prefix). */
async function fetchRole(api: ApiOptions, roleId: string): Promise<RoleInfo> {
  const role = await apiRequest<LcpRole>(api, 'GET', `/api/role/${roleId}`);
  return { name: role.name, slug: role.slug };
}

/** Assembles an {@link AgentContext} from an agent/assignment id pair and its already-resolved role. */
function buildAgentContext(
  agentId: string,
  assignmentId: string,
  roleId: string,
  role: RoleInfo,
): AgentContext {
  return {
    agentId,
    assignmentId,
    assignmentRole: role.name,
    roleId,
    roleSlug: role.slug,
  };
}

/**
 * Prints one audit row: a heading block when the active agent changes, then
 * the row's own formatted line(s) — `llm_request`/`llm_response` as a
 * pretty-printed JSON delta, `tool_call`/`tool_result` as pretty, untruncated,
 * wrapped JSON, and everything else as a single wrapped summary line.
 */
function printAuditRow(
  row: AuditRow,
  agentsById: Map<string, AgentContext>,
  tracker: LogHeadingTracker,
  jsonFormatter: JsonDeltaFormatter,
): void {
  const ctx = row.agentId ? agentsById.get(row.agentId) : undefined;
  if (ctx && tracker.shouldPrintHeading(ctx.agentId)) {
    for (const line of agentHeading(ctx)) process.stdout.write(line + '\n');
  }
  const time = formatTimestamp(row.timestamp);
  const width = process.stdout.columns ?? 80;
  const payload = row.payload ?? {};

  if (row.eventType === 'llm_request' || row.eventType === 'llm_response') {
    process.stdout.write(`${time} | ${row.eventType}\n`);
    const json = jsonFormatter.format(
      row.eventType,
      row.agentId ?? '',
      payload,
    );
    for (const line of json.split('\n')) process.stdout.write(`  ${line}\n`);
    return;
  }
  if (row.eventType === 'tool_call' || row.eventType === 'tool_result') {
    process.stdout.write(`${time} | ${row.eventType}\n`);
    for (const line of wrapText(JSON.stringify(payload), width)) {
      process.stdout.write(`  ${line}\n`);
    }
    return;
  }

  const label =
    row.eventType === 'agent_loop_completion'
      ? ASSIGNMENT_COMPLETE_LABEL
      : row.eventType;
  const text =
    row.eventType === 'state_change'
      ? `${typeof payload.newStatus === 'string' ? payload.newStatus : ''}${
          typeof payload.reason === 'string' ? ` (${payload.reason})` : ''
        }`
      : row.eventType === 'agent_loop_completion'
        ? typeof payload.summary === 'string'
          ? payload.summary
          : ''
        : JSON.stringify(payload);
  const header = `${time} | ${label} | `;
  const wrapped = wrapText(text, Math.max(width - header.length, 1));
  wrapped.forEach((line, i) => {
    process.stdout.write((i === 0 ? header : '  ') + line + '\n');
  });
}

/**
 * Resolved eavesdrop target: the working agent(s) to tail (with the context
 * needed for their heading blocks), where to fetch history from, and whether
 * the target has already finished (so `--tail` has nothing to follow).
 * `taskId` is set only for `--task-id` targets — it lets `--tail` keep
 * watching for assignments that appear after the initial fetch; `roleById` is
 * the company's role list fetched alongside it, reused so a newly-discovered
 * assignment doesn't need its own `fetchRole` round-trip when its role is
 * already known.
 */
interface Target {
  agents: AgentContext[];
  historyPath: string | null;
  terminal: boolean;
  taskId?: string;
  roleById?: Map<string, RoleInfo>;
}

async function resolveTarget(
  api: ApiOptions,
  cmdOpts: EavesdropCmdOpts,
): Promise<Target> {
  if (cmdOpts.agentId) {
    const agent = await apiRequest<LcpAgent>(
      api,
      'GET',
      `/api/agent/${cmdOpts.agentId}`,
    );
    const role = await fetchRole(api, agent.roleId);
    return {
      agents: [
        buildAgentContext(agent.id, agent.assignmentId, agent.roleId, role),
      ],
      historyPath: `/api/agent/${agent.id}/history`,
      terminal: TERMINAL_AGENT_STATUSES.has(agent.status),
    };
  }
  if (cmdOpts.assignmentId) {
    const assignment = await apiRequest<LcpAssignment>(
      api,
      'GET',
      `/api/assignment/${cmdOpts.assignmentId}`,
    );
    if (!assignment.agentId) {
      return {
        agents: [],
        historyPath: null,
        terminal:
          TERMINAL_ASSIGNMENT_STATUSES.has(assignment.status) ||
          !assignment.agentId,
      };
    }
    const role = await fetchRole(api, assignment.roleId);
    return {
      agents: [
        buildAgentContext(
          assignment.agentId,
          assignment.id,
          assignment.roleId,
          role,
        ),
      ],
      historyPath: `/api/agent/${assignment.agentId}/history`,
      terminal: TERMINAL_ASSIGNMENT_STATUSES.has(assignment.status),
    };
  }
  // --task-id: follow every assignment's working agent (plan, implement, qa,
  // finalise) — not any consultation spawned mid-assignment, which has no FK
  // back to the task (see the `010.3.1` plan's implementation notes).
  const { task, assignments } = await apiRequest<{
    task: LcpTask;
    assignments: LcpAssignment[];
  }>(api, 'GET', `/api/task/${cmdOpts.taskId}`);
  const roles = await apiRequest<LcpRole[]>(
    api,
    'GET',
    `/api/company/${task.companyId}/roles`,
  );
  const roleById = new Map<string, RoleInfo>(
    roles.map((r) => [r.id, { name: r.name, slug: r.slug }]),
  );
  const agents: AgentContext[] = assignments
    .filter((a): a is LcpAssignment & { agentId: string } => Boolean(a.agentId))
    .map((a) =>
      buildAgentContext(
        a.agentId,
        a.id,
        a.roleId,
        roleById.get(a.roleId) ?? {
          name: '',
          slug: '',
        },
      ),
    );
  return {
    agents,
    historyPath: `/api/task/${task.id}/history`,
    terminal: TERMINAL_TASK_STATUSES.has(task.status),
    taskId: task.id,
    roleById,
  };
}

/**
 * Follows one agent's live SSE stream (`GET /api/agent/:id/events`),
 * rendering every event with the same renderer `chat` uses, until a
 * terminal (`completed`/`failed`) event arrives or the stream closes. Prints
 * this agent's heading block first if the active agent changed.
 */
async function followAgent(
  lcpServer: string,
  tokenManager: TokenManager,
  ctx: AgentContext,
  tracker: LogHeadingTracker,
): Promise<void> {
  const url = `${lcpServer.replace(/\/$/, '')}/api/agent/${ctx.agentId}/events`;
  if (tracker.shouldPrintHeading(ctx.agentId)) {
    for (const line of agentHeading(ctx)) process.stdout.write(line + '\n');
  }
  const renderer = createRenderer({
    hideReasoning: false,
    rolePrefix: `${shortId(ctx.agentId)} (${ctx.roleSlug})`,
    out: process.stdout,
    err: process.stderr,
  });
  try {
    // Read the token at connection time, not when this follower was queued —
    // a long `--tail` can outlive its original token (see TokenManager).
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${tokenManager.current}` },
    });
    if (!res.ok || !res.body) {
      process.stderr.write(
        `Error: events stream for agent ${ctx.agentId} failed with HTTP ${res.status}\n`,
      );
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let terminal = false;
    while (!terminal) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseBuffer(buffer);
      buffer = rest;
      for (const event of events) {
        if (event.kind === 'completed' || event.kind === 'failed') {
          terminal = true;
        }
        renderer.render(event);
      }
    }
  } finally {
    renderer.finish();
  }
}

/**
 * Fetches a newly-appeared assignment's working agent context, or `undefined`
 * if it has none yet. `roleById` (the company's role list, fetched once by
 * `resolveTarget`) is checked first — only a role id it doesn't recognise
 * falls back to its own `fetchRole` round-trip.
 */
async function resolveNewAssignmentAgent(
  lcpServer: string,
  tokenManager: TokenManager,
  assignmentId: string,
  roleById: Map<string, RoleInfo>,
): Promise<AgentContext | undefined> {
  // Built fresh (not the caller's original ApiOptions) so a token refreshed
  // since `--tail` started is used for this assignment, discovered mid-tail.
  const api: ApiOptions = { baseUrl: lcpServer, token: tokenManager.current };
  const assignment = await apiRequest<LcpAssignment>(
    api,
    'GET',
    `/api/assignment/${assignmentId}`,
  );
  if (!assignment.agentId) return undefined;
  const role =
    roleById.get(assignment.roleId) ??
    (await fetchRole(api, assignment.roleId));
  return buildAgentContext(
    assignment.agentId,
    assignment.id,
    assignment.roleId,
    role,
  );
}

/**
 * Tails every agent context given, plus (for a `--task-id` target) any
 * assignment that appears later in the task — subscribing to the task's own
 * SSE stream (`GET /api/task/:id/events`) alongside the initial per-agent
 * follows so a QA/implement/finalise agent (or a consultation, once
 * `parentAssignmentId`/`taskId` inheritance puts it on this stream) that
 * starts after `eavesdrop` connects is still picked up, rather than tailing
 * only the assignments that existed at start time.
 *
 * Waits in waves: each pass awaits every follower known at the time it
 * started, then re-checks whether the follower list grew while waiting (a
 * new assignment discovered mid-wave) before deciding it's done — so a
 * follower that appears while an earlier one is still running is never
 * missed, without any busy-looping once the list stops growing.
 */
async function tailTarget(
  opts: GlobalOptions,
  tokenManager: TokenManager,
  target: Target,
  tracker: LogHeadingTracker,
): Promise<void> {
  const followers: Promise<void>[] = target.agents.map((ctx) =>
    followAgent(opts.lcpServer, tokenManager, ctx, tracker),
  );

  let watchAbort: AbortController | undefined;
  let watchDone: Promise<void> | undefined;
  if (target.taskId) {
    const known = new Set(target.agents.map((a) => a.assignmentId));
    const roleById = target.roleById ?? new Map<string, RoleInfo>();
    watchAbort = new AbortController();
    const taskId = target.taskId;
    watchDone = readSseStream(
      `${opts.lcpServer.replace(/\/$/, '')}/api/task/${taskId}/events`,
      tokenManager.current,
      watchAbort.signal,
      (event) => {
        if (event.kind !== 'assignment_changed') return;
        const assignmentId = (event.data as { id?: string } | undefined)?.id;
        if (!assignmentId || known.has(assignmentId)) return;
        known.add(assignmentId);
        followers.push(
          resolveNewAssignmentAgent(
            opts.lcpServer,
            tokenManager,
            assignmentId,
            roleById,
          ).then((ctx) =>
            ctx
              ? followAgent(opts.lcpServer, tokenManager, ctx, tracker)
              : undefined,
          ),
        );
      },
    );
  }

  let settledCount = 0;
  while (settledCount < followers.length) {
    settledCount = followers.length;
    await Promise.all(followers.slice());
  }
  watchAbort?.abort();
  await watchDone;
}

/**
 * Eavesdrops on an agent, assignment, or task (exactly one of `--agent-id`,
 * `--assignment-id`, `--task-id`): reconstructs its history from the audit
 * log (`--show-history`) and/or follows it live (`--tail`).
 *
 * `--show-history` prints every recorded event to stdout, oldest first,
 * grouped under a heading block whenever the active agent changes.
 * `--tail` follows the target's working agent(s) via their SSE event
 * streams, rendered the same way `chat` renders its own agent's stream;
 * warns and exits (non-zero) if the target has already finished (or, for
 * `--assignment-id`, hasn't started).
 */
export function eavesdropAction(
  opts: GlobalOptions,
  cmdOpts: EavesdropCmdOpts,
): Promise<void> {
  return runCommand(async () => {
    const targetsGiven = [
      cmdOpts.agentId,
      cmdOpts.assignmentId,
      cmdOpts.taskId,
    ].filter(Boolean).length;
    if (targetsGiven !== 1) {
      process.stderr.write(
        'Error: pass exactly one of --agent-id, --assignment-id, --task-id\n',
      );
      process.exit(1);
      return;
    }
    if (!cmdOpts.showHistory && !cmdOpts.tail) {
      process.stderr.write('Error: pass --show-history and/or --tail\n');
      process.exit(1);
      return;
    }

    const session = await resolveSession({ ...opts, baseUrl: opts.lcpServer });
    const tokenManager = new TokenManager(opts.lcpServer, session);
    const api = apiOptions(opts, tokenManager.current);
    const target = await resolveTarget(api, cmdOpts);
    const agentsById = new Map(target.agents.map((a) => [a.agentId, a]));
    const tracker = new LogHeadingTracker();

    if (cmdOpts.showHistory) {
      const rows = target.historyPath
        ? await apiRequest<AuditRow[]>(api, 'GET', target.historyPath)
        : [];
      const jsonFormatter = new JsonDeltaFormatter();
      for (const row of rows) {
        printAuditRow(row, agentsById, tracker, jsonFormatter);
      }
    }

    if (cmdOpts.tail) {
      if (target.terminal || target.agents.length === 0) {
        process.stderr.write(
          'Warning: nothing to tail — the target has already finished (or has not started)\n',
        );
        process.exit(1);
        return;
      }
      await tailTarget(opts, tokenManager, target, tracker);
    }
    tokenManager.stop();
  });
}
