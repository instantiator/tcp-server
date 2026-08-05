// Following an eavesdrop target live: one SSE subscription per working agent,
// plus (for a task target) a watch on the task itself so assignments that begin
// after `eavesdrop` connects are picked up too.

import type { AuditWireEvent, TcpAssignment } from '@tcp/shared';
import { TokenManager } from '../auth/token';
import { apiRequest, ApiOptions } from '../core/api';
import { GlobalOptions } from '../core/cli-options';
import { parseWireEvents } from '../core/sse';
import { readWireStream } from '../core/sse-reader';
import { EventLogBuffer } from '../render/event-log';
import {
  AgentContext,
  buildAgentContext,
  fetchRole,
  RoleInfo,
  Target,
  TERMINAL_AGENT_STATUSES,
} from './eavesdrop-target';

/** True for a terminal agent `state_change` — the signal to stop following. */
function isTerminalAgentEvent(e: AuditWireEvent): boolean {
  return (
    e.eventType === 'state_change' &&
    e.payload['entity'] === 'agent' &&
    TERMINAL_AGENT_STATUSES.has(String(e.payload['newStatus']))
  );
}

/**
 * Follows one agent's live SSE stream (`GET /api/agent/:id/events`), feeding
 * every wire event into the shared render buffer (which inserts a heading block
 * when the active agent changes), until a terminal agent `state_change` arrives
 * or the stream closes.
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
 * if it has none yet.
 *
 * NB. `roleById` (the company's role list, fetched once by `resolveTarget`) is
 * checked first — only a role id it doesn't recognise falls back to its own
 * {@link fetchRole} round-trip.
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
 * assignment that appears later in the task.
 *
 * The task's own SSE stream (`GET /api/task/:id/events`) is subscribed to
 * alongside the initial per-agent follows, so a QA/implement/finalise agent
 * (or a consultation, once `parentAssignmentId`/`taskId` inheritance puts it on
 * this stream) that starts after `eavesdrop` connects is still picked up,
 * rather than tailing only the assignments that existed at start time.
 *
 * NB. this waits in waves: each pass awaits every follower known at the time it
 * started, then re-checks whether the follower list grew while waiting (a new
 * assignment discovered mid-wave) before deciding it's done — so a follower
 * that appears while an earlier one is still running is never missed, without
 * any busy-looping once the list stops growing.
 */
export async function tailTarget(
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
