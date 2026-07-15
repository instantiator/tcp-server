import type { LcpAgent, LcpAssignment, LcpTask } from '@lcp/shared';
import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { createRenderer } from '../core/render';
import { parseSseBuffer } from '../core/sse';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

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
  payload?: Record<string, unknown>;
}

const TERMINAL_AGENT_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_ASSIGNMENT_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);
const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * Formats one audit row as a printable `hh:mm:ss | eventType | summary` line
 * — the same convention as the TUI's chat log, though (unlike the live SSE
 * `AgentEvent` stream `--tail` renders with) audit rows carry raw
 * `llm_request`/`llm_response`/`tool_call`/`tool_result` payloads (the exact
 * LangChain event data written by lcp-agent), not pre-formatted deltas, so
 * those are summarised generically rather than replayed token-by-token.
 * ponytail: a full audit→AgentEvent replay mapper is the upgrade path if
 * byte-identical formatting is ever required here.
 */
function formatAuditRow(row: AuditRow): string {
  const time = new Date(row.timestamp).toTimeString().slice(0, 8);
  const payload = row.payload ?? {};
  let summary: string;
  switch (row.eventType) {
    case 'state_change': {
      const status =
        typeof payload.newStatus === 'string' ? payload.newStatus : '';
      const reason =
        typeof payload.reason === 'string' ? ` (${payload.reason})` : '';
      summary = `${status}${reason}`;
      break;
    }
    case 'agent_loop_completion':
      summary = typeof payload.summary === 'string' ? payload.summary : '';
      break;
    default:
      summary = JSON.stringify(payload).slice(0, 200);
  }
  return `${time} | ${row.eventType} | ${summary}`;
}

/**
 * Resolved eavesdrop target: which agent(s) to tail, where to fetch history
 * from, and whether the target has already finished (so `--tail` has
 * nothing to follow).
 */
interface Target {
  agentIds: string[];
  historyPath: string | null;
  terminal: boolean;
}

async function resolveTarget(
  api: Parameters<typeof apiRequest>[0],
  cmdOpts: EavesdropCmdOpts,
): Promise<Target> {
  if (cmdOpts.agentId) {
    const agent = await apiRequest<LcpAgent>(
      api,
      'GET',
      `/api/agent/${cmdOpts.agentId}`,
    );
    return {
      agentIds: [agent.id],
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
    return {
      agentIds: assignment.agentId ? [assignment.agentId] : [],
      historyPath: assignment.agentId
        ? `/api/agent/${assignment.agentId}/history`
        : null,
      terminal:
        TERMINAL_ASSIGNMENT_STATUSES.has(assignment.status) ||
        !assignment.agentId,
    };
  }
  // --task-id: follow every assignment's working agent (plan, implement, qa,
  // finalise) — not any consultation spawned mid-assignment, which has no FK
  // back to the task (see the `010.3.1` plan's implementation notes).
  const { task, assignments } = await apiRequest<{
    task: LcpTask;
    assignments: LcpAssignment[];
  }>(api, 'GET', `/api/task/${cmdOpts.taskId}`);
  return {
    agentIds: assignments
      .map((a) => a.agentId)
      .filter((id): id is NonNullable<typeof id> => Boolean(id)),
    historyPath: `/api/task/${task.id}/history`,
    terminal: TERMINAL_TASK_STATUSES.has(task.status),
  };
}

/**
 * Follows one agent's live SSE stream (`GET /api/agent/:id/events`),
 * rendering every event with the same renderer `chat` uses, until a
 * terminal (`completed`/`failed`) event arrives or the stream closes.
 */
async function followAgent(
  lcpServer: string,
  token: string,
  agentId: string,
): Promise<void> {
  const url = `${lcpServer.replace(/\/$/, '')}/api/agent/${agentId}/events`;
  const renderer = createRenderer({
    hideReasoning: false,
    rolePrefix: agentId,
    out: process.stdout,
    err: process.stderr,
  });
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok || !res.body) {
      process.stderr.write(
        `Error: events stream for agent ${agentId} failed with HTTP ${res.status}\n`,
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
 * Eavesdrops on an agent, assignment, or task (exactly one of `--agent-id`,
 * `--assignment-id`, `--task-id`): reconstructs its history from the audit
 * log (`--show-history`) and/or follows it live (`--tail`).
 *
 * `--show-history` prints every recorded event to stdout, oldest first.
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

    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const api = apiOptions(opts, token);
    const target = await resolveTarget(api, cmdOpts);

    if (cmdOpts.showHistory) {
      const rows = target.historyPath
        ? await apiRequest<AuditRow[]>(api, 'GET', target.historyPath)
        : [];
      for (const row of rows) {
        process.stdout.write(formatAuditRow(row) + '\n');
      }
    }

    if (cmdOpts.tail) {
      if (target.terminal || target.agentIds.length === 0) {
        process.stderr.write(
          'Warning: nothing to tail — the target has already finished (or has not started)\n',
        );
        process.exit(1);
        return;
      }
      await Promise.all(
        target.agentIds.map((id) => followAgent(opts.lcpServer, token, id)),
      );
    }
  });
}
