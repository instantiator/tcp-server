// Every tcp-server REST call a chat session makes, as plain functions over a
// TokenManager. Keeping them together means the session class reads as
// orchestration — which call, in what order, and what it does with the
// result — rather than a list of URLs.

import type { TcpTask, TaskChangeSummary } from '@tcp/shared';
import { planIndexFromShortcode } from '@tcp/shared';
import type { UUID } from 'crypto';
import { TokenManager } from '../auth/token';
import type { TaskDetailBody } from '../core/api';
import { AuditRow } from '../render/audit-wire';
import { AssignmentInfo, InitiateTaskSubmission, RoleOption } from '../tui/tui';

/** A chat agent as `POST /api/agent/chat/start` and `GET /api/agent/:id` return it. */
export interface AgentRecord {
  id: string;
  status: string;
  assignmentId: string;
}

/** Plain shape of `GET /api/assignment/:id` — just what a pane's heading needs. */
export interface AssignmentRecord {
  id: string;
  shortcode: string | null;
  status: string;
  prompt: string;
}

/** Plain shape of `GET /api/task?companyId=` rows — just what the task list needs. */
interface TaskRecord {
  id: string;
  status: string;
  request: string;
  shortcode: string;
  createdAt: string;
  updatedAt: string;
}

/** A task with its assignments, resolved for the task panel's list. */
export interface TaskDetail {
  task: TcpTask;
  assignments: AssignmentInfo[];
}

/** Fetches the company's role roster, sorted alphabetically by name. */
export async function fetchRoles(
  tokens: TokenManager,
  companyId: string,
): Promise<RoleOption[]> {
  const roles = await tokens.request<RoleOption[]>(
    'GET',
    `/api/company/${companyId}/roles`,
  );
  return roles.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Fetches the company's current tasks.
 *
 * NB. step counts aren't in this plain listing — the placeholders here are
 * corrected almost immediately by the company SSE stream's priming
 * `task_changed` events.
 */
export async function fetchTasks(
  tokens: TokenManager,
  companyId: string,
): Promise<TaskChangeSummary[]> {
  const tasks = await tokens.request<TaskRecord[]>(
    'GET',
    `/api/task?companyId=${companyId}`,
  );
  return tasks.map((task) => ({
    id: task.id as UUID,
    status: task.status as TaskChangeSummary['status'],
    request: task.request,
    shortcode: task.shortcode,
    // Same discipline as parseTaskChangeSummary: don't trust the wire shape
    // blindly — a non-string date field must not reach RosterPane's
    // `.localeCompare` sort and crash the TUI.
    createdAt: typeof task.createdAt === 'string' ? task.createdAt : '',
    updatedAt: typeof task.updatedAt === 'string' ? task.updatedAt : '',
    completedSteps: 0,
    totalSteps: 0,
  }));
}

/**
 * Fetches a task with its assignments, resolving each assignment's role id to
 * its display name for the task panel's Assignments list.
 *
 * NB. the two fetches are independent — a session's tasks always belong to its
 * own `companyId` — so they run in parallel rather than waiting for the task
 * fetch to learn its companyId.
 */
export async function fetchTaskDetail(
  tokens: TokenManager,
  companyId: string,
  taskId: string,
): Promise<TaskDetail> {
  const [{ assignments, ...task }, roles] = await Promise.all([
    tokens.request<TaskDetailBody>('GET', `/api/task/${taskId}`),
    tokens.request<{ id: string; name: string; slug: string }[]>(
      'GET',
      `/api/company/${companyId}/roles`,
    ),
  ]);
  const roleById = new Map(roles.map((r) => [r.id, r]));
  return {
    task,
    assignments: assignments.map((a) => {
      const shortcode = a.shortcode ?? null;
      return {
        id: a.id,
        role: roleById.get(a.roleId)?.name ?? a.roleId,
        roleSlug: roleById.get(a.roleId)?.slug ?? a.roleId,
        mode: a.mode,
        status: a.status,
        prompt: a.prompt,
        shortcode,
        planIndex: planIndexFromShortcode(shortcode),
        agentId: a.agentId ?? null,
        failureReason: a.failureReason ?? null,
      };
    }),
  };
}

/** Fetches the company's default planner role id (`TcpCompany.plannerRoleId`), if it has one. */
export async function fetchCompanyDefaultPlannerRoleId(
  tokens: TokenManager,
  companyId: string,
): Promise<string | undefined> {
  const company = await tokens.request<{ plannerRoleId?: string | null }>(
    'GET',
    `/api/company/${companyId}`,
  );
  return company.plannerRoleId ?? undefined;
}

/**
 * Creates a task from the initiate-task form's submission, starting it
 * immediately when requested, then returns its detail the same way
 * {@link fetchTaskDetail} does (for the task panel this hands off to).
 */
export async function createTask(
  tokens: TokenManager,
  submission: InitiateTaskSubmission,
): Promise<TaskDetail> {
  const expected = submission.expected.map((filename) => ({
    type: 'task-completed-path' as const,
    value: filename,
  }));
  const created = await tokens.request<TcpTask>('POST', '/api/task', {
    companyId: submission.companyId,
    request: submission.request,
    plannerRoleId: submission.plannerRoleId,
    ...(expected.length > 0 ? { expected } : {}),
  });
  if (submission.startImmediately) {
    await tokens.request('POST', `/api/task/${created.id}/start`);
  }
  return fetchTaskDetail(tokens, submission.companyId, created.id);
}

/** Cancels a running task. */
export async function cancelTask(
  tokens: TokenManager,
  taskId: string,
): Promise<void> {
  await tokens.request('POST', `/api/task/${taskId}/cancel`);
}

/** Starts a `ready` task. */
export async function startTask(
  tokens: TokenManager,
  taskId: string,
): Promise<void> {
  await tokens.request('POST', `/api/task/${taskId}/start`);
}

/** Creates a new chat-mode agent for `roleId`. */
export async function startChatAgent(
  tokens: TokenManager,
  companyId: string,
  roleId: string,
): Promise<AgentRecord> {
  return tokens.request<AgentRecord>('POST', '/api/agent/chat/start', {
    companyId,
    roleId,
  });
}

/** Fetches one assignment, for a pane's heading block. */
export async function fetchAssignment(
  tokens: TokenManager,
  assignmentId: string,
): Promise<AssignmentRecord> {
  return tokens.request<AssignmentRecord>(
    'GET',
    `/api/assignment/${assignmentId}`,
  );
}

/** Fetches one agent's current record. */
export async function fetchAgent(
  tokens: TokenManager,
  agentId: string,
): Promise<AgentRecord> {
  return tokens.request<AgentRecord>('GET', `/api/agent/${agentId}`);
}

/** Fetches one agent's audit history, oldest first. */
export async function fetchAgentHistory(
  tokens: TokenManager,
  agentId: string,
): Promise<AuditRow[]> {
  return tokens.request<AuditRow[]>('GET', `/api/agent/${agentId}/history`);
}

/** Deletes one agent. */
export async function deleteAgent(
  tokens: TokenManager,
  agentId: string,
): Promise<void> {
  await tokens.request('DELETE', `/api/agent/${agentId}`);
}
