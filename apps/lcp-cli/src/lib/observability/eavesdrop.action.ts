import type {
  AuditWireEvent,
  TcpAgent,
  TcpAssignment,
  TcpRole,
  TcpTask,
} from '@lcp/shared';
import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest, ApiOptions } from '../core/api';
import { parseWireEvents } from '../core/sse';
import { readWireStream } from '../core/sse-reader';
import { runCommand } from '../core/run-command';
import { EventLogBuffer } from '../render/event-log';
import { HeadingInfoProvider } from '../render/heading';
import { StreamPresenter } from '../render/stream-presenter';
import { ansiStyle, plainStyle } from '../render/style';
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
  id?: string;
  timestamp: string;
  companyId?: string;
  role?: string;
  agentId?: string | null;
  assignmentId?: string | null;
  taskId?: string | null;
  eventType: string;
  payload?: Record<string, unknown>;
}

/** Converts a persisted history row to the {@link AuditWireEvent} the render buffer consumes. */
function toWire(row: AuditRow): AuditWireEvent {
  return {
    id: row.id,
    timestamp: row.timestamp,
    companyId: row.companyId ?? '',
    role: row.role ?? '',
    agentId: row.agentId ?? null,
    assignmentId: row.assignmentId ?? null,
    taskId: row.taskId ?? null,
    eventType: row.eventType as AuditWireEvent['eventType'],
    payload: row.payload ?? {},
  };
}

/** Identifies the working agent behind one assignment, for the heading block. */
interface AgentContext {
  agentId: string;
  assignmentId: string;
  assignmentRole: string;
  roleId: string;
  roleSlug: string;
}

/** Builds a {@link HeadingInfoProvider} backed by the (mutable) resolved-agent map. */
function headingProvider(
  agentsById: Map<string, AgentContext>,
): HeadingInfoProvider {
  return (scope) => {
    const ctx = scope.agentId ? agentsById.get(scope.agentId) : undefined;
    return {
      taskId: scope.taskId ?? undefined,
      assignmentId: ctx?.assignmentId ?? scope.assignmentId ?? undefined,
      assignmentRole: ctx?.assignmentRole,
      assignmentRoleSlug: ctx?.roleSlug,
      assignmentRoleId: ctx?.roleId,
      agentId: scope.agentId ?? undefined,
    };
  };
}

/** True for a terminal agent `state_change` — the signal to stop following. */
function isTerminalAgentEvent(e: AuditWireEvent): boolean {
  return (
    e.eventType === 'state_change' &&
    e.payload['entity'] === 'agent' &&
    TERMINAL_AGENT_STATUSES.has(String(e.payload['newStatus']))
  );
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

/** Fetches one role's name/slug (for the heading block and short-id prefix). */
async function fetchRole(api: ApiOptions, roleId: string): Promise<RoleInfo> {
  const role = await apiRequest<TcpRole>(api, 'GET', `/api/role/${roleId}`);
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
    const agent = await apiRequest<TcpAgent>(
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
    const assignment = await apiRequest<TcpAssignment>(
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
    task: TcpTask;
    assignments: TcpAssignment[];
  }>(api, 'GET', `/api/task/${cmdOpts.taskId}`);
  const roles = await apiRequest<TcpRole[]>(
    api,
    'GET',
    `/api/company/${task.companyId}/roles`,
  );
  const roleById = new Map<string, RoleInfo>(
    roles.map((r) => [r.id, { name: r.name, slug: r.slug }]),
  );
  const agents: AgentContext[] = assignments
    .filter((a): a is TcpAssignment & { agentId: string } => Boolean(a.agentId))
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
 * Follows one agent's live SSE stream (`GET /api/agent/:id/events`), feeding
 * every {@link WireEvent} into the shared render buffer (which inserts a
 * heading block when the active agent changes), until a terminal agent
 * `state_change` arrives or the stream closes.
 */
async function followAgent(
  tcpServer: string,
  tokenManager: TokenManager,
  agentId: string,
  buffer: EventLogBuffer,
): Promise<void> {
  const url = `${tcpServer.replace(/\/$/, '')}/api/agent/${agentId}/events`;
  // Read the token at connection time, not when this follower was queued —
  // a long `--tail` can outlive its original token (see TokenManager).
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${tokenManager.current}` },
  });
  if (!res.ok || !res.body) {
    process.stderr.write(
      `Error: events stream for agent ${agentId} failed with HTTP ${res.status}\n`,
    );
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let terminal = false;
  while (!terminal) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const { events, rest } = parseWireEvents(buf);
    buf = rest;
    for (const wire of events) {
      if (wire.type === 'stream') {
        buffer.appendDelta(wire);
        continue;
      }
      buffer.appendAudit(wire.event);
      if (isTerminalAgentEvent(wire.event)) terminal = true;
    }
  }
}

/**
 * Fetches a newly-appeared assignment's working agent context, or `undefined`
 * if it has none yet. `roleById` (the company's role list, fetched once by
 * `resolveTarget`) is checked first — only a role id it doesn't recognise
 * falls back to its own `fetchRole` round-trip.
 */
async function resolveNewAssignmentAgent(
  tcpServer: string,
  tokenManager: TokenManager,
  assignmentId: string,
  roleById: Map<string, RoleInfo>,
): Promise<AgentContext | undefined> {
  // Built fresh (not the caller's original ApiOptions) so a token refreshed
  // since `--tail` started is used for this assignment, discovered mid-tail.
  const api: ApiOptions = { baseUrl: tcpServer, token: tokenManager.current };
  const assignment = await apiRequest<TcpAssignment>(
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
  buffer: EventLogBuffer,
  agentsById: Map<string, AgentContext>,
): Promise<void> {
  const followers: Promise<void>[] = target.agents.map((ctx) =>
    followAgent(opts.tcpServer, tokenManager, ctx.agentId, buffer),
  );

  let watchAbort: AbortController | undefined;
  let watchDone: Promise<void> | undefined;
  if (target.taskId) {
    const known = new Set(target.agents.map((a) => a.assignmentId));
    const roleById = target.roleById ?? new Map<string, RoleInfo>();
    watchAbort = new AbortController();
    const taskId = target.taskId;
    watchDone = readWireStream(
      `${opts.tcpServer.replace(/\/$/, '')}/api/task/${taskId}/events`,
      tokenManager.current,
      watchAbort.signal,
      (wire) => {
        if (
          wire.type !== 'audit' ||
          wire.event.eventType !== 'state_change' ||
          wire.event.payload['entity'] !== 'assignment'
        ) {
          return;
        }
        const assignmentId = wire.event.assignmentId ?? undefined;
        if (!assignmentId || known.has(assignmentId)) return;
        known.add(assignmentId);
        followers.push(
          resolveNewAssignmentAgent(
            opts.tcpServer,
            tokenManager,
            assignmentId,
            roleById,
          ).then((ctx) => {
            if (!ctx) return undefined;
            agentsById.set(ctx.agentId, ctx);
            return followAgent(
              opts.tcpServer,
              tokenManager,
              ctx.agentId,
              buffer,
            );
          }),
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

    const session = await resolveSession({ ...opts, baseUrl: opts.tcpServer });
    const tokenManager = new TokenManager(opts.tcpServer, session);
    const api = apiOptions(opts, tokenManager.current);
    const target = await resolveTarget(api, cmdOpts);
    const agentsById = new Map(target.agents.map((a) => [a.agentId, a]));

    // One buffer + presenter for the whole session: `--show-history` and
    // `--tail` feed the same pipeline, so history and live are one stream.
    // Everything goes to stdout (coloured only when it's a TTY).
    const buffer = new EventLogBuffer(headingProvider(agentsById));
    new StreamPresenter(buffer, {
      out: process.stdout,
      err: process.stdout,
      style: process.stdout.isTTY ? ansiStyle : plainStyle,
    });

    if (cmdOpts.showHistory) {
      const rows = target.historyPath
        ? await apiRequest<AuditRow[]>(api, 'GET', target.historyPath)
        : [];
      for (const row of rows) buffer.appendAudit(toWire(row));
    }

    if (cmdOpts.tail) {
      if (target.terminal || target.agents.length === 0) {
        process.stderr.write(
          'Warning: nothing to tail — the target has already finished (or has not started)\n',
        );
        process.exit(1);
        return;
      }
      await tailTarget(opts, tokenManager, target, buffer, agentsById);
    }
    tokenManager.stop();
  });
}
