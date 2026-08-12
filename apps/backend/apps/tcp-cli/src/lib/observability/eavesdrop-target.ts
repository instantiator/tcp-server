// Working out what `eavesdrop` is actually watching: which agent(s) sit behind
// the given --agent-id/--assignment-id/--task-id, where their history lives,
// and whether there is anything left to follow.

import type {
  TcpAgent,
  TcpAssignment,
  TcpRole,
  TcpTask,
  HeadingInfoProvider,
} from '@tcp/shared';
import { apiRequest, ApiOptions } from '../core/api';

/** The three mutually-exclusive ways to name an eavesdrop target; exactly one is set. */
export interface TargetRef {
  agentId?: string;
  assignmentId?: string;
  taskId?: string;
}

/** Identifies the working agent behind one assignment, for the heading block. */
export interface AgentContext {
  agentId: string;
  assignmentId: string;
  assignmentRole: string;
  roleId: string;
  roleSlug: string;
}

/** A role's display name/slug — all {@link buildAgentContext}/{@link fetchRole} need. */
export interface RoleInfo {
  name: string;
  slug: string;
}

/** Statuses beyond which an agent has nothing left to stream. */
export const TERMINAL_AGENT_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
]);

const TERMINAL_ASSIGNMENT_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);

const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * Resolved eavesdrop target: the working agent(s) to tail (with the context
 * needed for their heading blocks), where to fetch history from, and whether
 * the target has already finished (so `--tail` has nothing to follow).
 *
 * NB. `taskId` is set only for `--task-id` targets — it lets `--tail` keep
 * watching for assignments that appear after the initial fetch. `roleById` is
 * the company's role list fetched alongside it, reused so a newly-discovered
 * assignment doesn't need its own {@link fetchRole} round-trip when its role is
 * already known.
 */
export interface Target {
  agents: AgentContext[];
  historyPath: string | null;
  terminal: boolean;
  taskId?: string;
  roleById?: Map<string, RoleInfo>;
}

/** Builds a {@link HeadingInfoProvider} backed by the (mutable) resolved-agent map. */
export function headingProvider(
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

/** Fetches one role's name/slug (for the heading block and short-id prefix). */
export async function fetchRole(
  api: ApiOptions,
  roleId: string,
): Promise<RoleInfo> {
  const role = await apiRequest<TcpRole>(api, 'GET', `/api/role/${roleId}`);
  return { name: role.name, slug: role.slug };
}

/** Assembles an {@link AgentContext} from an agent/assignment id pair and its already-resolved role. */
export function buildAgentContext(
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

/** Resolves the command's single `--agent-id`/`--assignment-id`/`--task-id` into a {@link Target}. */
export async function resolveTarget(
  api: ApiOptions,
  cmdOpts: TargetRef,
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
