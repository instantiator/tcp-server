import { useMutation, useQuery } from '@tanstack/react-query';

import { api, expectAccepted, postFile, unwrap } from './client';
import { apiError, networkError } from './errors';
import {
  queryKeys,
  type AgentListParams,
  type AssignmentListParams,
  type CompanyListParams,
  type ConversationListParams,
  type TaskListParams,
} from './query-keys';
import type { components } from './schema';
import { readWarnings } from './warnings';

/**
 * One hook per REST route, as TanStack Query hooks (ADR-021). Internal to
 * `src/api/` — components import `hooks.ts`, not this file.
 *
 * Every hook is the same three lines: a key from `query-keys.ts`, and a call
 * through {@link unwrap} so a failure arrives as an `ApiError`. None of them
 * sets `staleTime`, `refetchInterval` or `retry` — live events are how this
 * application stays fresh (ADR-025), and a poll alongside them would be a
 * second, slower, disagreeing answer to the same question.
 *
 * Hooks are named after the route; keys are named after the event entity. The
 * two disagree for conversations, and `query-keys.ts` explains why.
 */

export const useCompanies = (params: CompanyListParams = {}) =>
  useQuery({
    queryKey: queryKeys.companies(params),
    queryFn: () =>
      unwrap(api.GET('/api/company', { params: { query: params } })),
  });

export const useCompany = (id: string) =>
  useQuery({
    queryKey: queryKeys.company(id),
    queryFn: () =>
      unwrap(api.GET('/api/company/{id}', { params: { path: { id } } })),
  });

export const useAgents = (params: AgentListParams = {}) =>
  useQuery({
    queryKey: queryKeys.agents(params),
    queryFn: () => unwrap(api.GET('/api/agent', { params: { query: params } })),
  });

export const useAgent = (id: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.agent(id),
    queryFn: () =>
      unwrap(api.GET('/api/agent/{id}', { params: { path: { id } } })),
    enabled,
  });

export const useAgentHistory = (id: string) =>
  useQuery({
    queryKey: queryKeys.agentHistory(id),
    queryFn: () =>
      unwrap(api.GET('/api/agent/{id}/history', { params: { path: { id } } })),
  });

/**
 * The one agent holding an assignment. Agent and assignment are 1:1, so the
 * list route filtered by `assignmentId` returns at most one row.
 *
 * Resolves to `null`, not `undefined`, when there is no such agent — TanStack
 * Query treats an `undefined` result as a bug and throws.
 */
export const useAgentByAssignment = (assignmentId: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.agentByAssignment(assignmentId),
    queryFn: async () => {
      const rows = await unwrap(
        api.GET('/api/agent', { params: { query: { assignmentId } } }),
      );
      return rows[0] ?? null;
    },
    enabled,
  });

export const useTasks = (params: TaskListParams) =>
  useQuery({
    queryKey: queryKeys.tasks(params),
    queryFn: () => unwrap(api.GET('/api/task', { params: { query: params } })),
  });

export const useTask = (id: string) =>
  useQuery({
    queryKey: queryKeys.task(id),
    queryFn: () =>
      unwrap(api.GET('/api/task/{id}', { params: { path: { id } } })),
  });

export const useTaskHistory = (id: string) =>
  useQuery({
    queryKey: queryKeys.taskHistory(id),
    queryFn: () =>
      unwrap(api.GET('/api/task/{id}/history', { params: { path: { id } } })),
  });

export const useAssignments = (params: AssignmentListParams = {}) =>
  useQuery({
    queryKey: queryKeys.assignments(params),
    queryFn: () =>
      unwrap(api.GET('/api/assignment', { params: { query: params } })),
  });

export const useAssignment = (id: string) =>
  useQuery({
    queryKey: queryKeys.assignment(id),
    queryFn: () =>
      unwrap(api.GET('/api/assignment/{id}', { params: { path: { id } } })),
  });

// Named after the route (conversation), keyed on 'enquiry' — see the note at
// the top of query-keys.ts for why.
export const useConversations = (params: ConversationListParams) =>
  useQuery({
    queryKey: queryKeys.conversations(params),
    queryFn: () =>
      unwrap(api.GET('/api/conversation', { params: { query: params } })),
  });

export const useConversation = (slug: string) =>
  useQuery({
    queryKey: queryKeys.conversation(slug),
    queryFn: () =>
      unwrap(
        api.GET('/api/conversation/{slug}', { params: { path: { slug } } }),
      ),
  });

export const useCompanyRoles = (companyId: string) =>
  useQuery({
    queryKey: queryKeys.companyRoles(companyId),
    queryFn: () =>
      unwrap(
        api.GET('/api/company/{id}/roles', {
          params: { path: { id: companyId } },
        }),
      ),
  });

export const useRoleBySlug = (companyId: string, slug: string) =>
  useQuery({
    queryKey: queryKeys.roleBySlug(companyId, slug),
    queryFn: () =>
      unwrap(
        api.GET('/api/company/{companyId}/roles/by-slug/{slug}', {
          params: { path: { companyId, slug } },
        }),
      ),
  });

export const useRole = (id: string) =>
  useQuery({
    queryKey: queryKeys.role(id),
    queryFn: () =>
      unwrap(api.GET('/api/role/{id}', { params: { path: { id } } })),
  });

export const useCompanyUsers = (companyId: string) =>
  useQuery({
    queryKey: queryKeys.companyUsers(companyId),
    queryFn: () =>
      unwrap(
        api.GET('/api/company/{companyId}/users', {
          params: { path: { companyId } },
        }),
      ),
  });

export const useRoleKnowledge = (roleId: string) =>
  useQuery({
    queryKey: queryKeys.roleKnowledge(roleId),
    queryFn: () =>
      unwrap(
        api.GET('/api/role/{roleId}/knowledge', {
          params: { path: { roleId } },
        }),
      ),
  });

export const useRoleKnowledgeStatus = (roleId: string) =>
  useQuery({
    queryKey: queryKeys.roleKnowledgeStatus(roleId),
    queryFn: () =>
      unwrap(
        api.GET('/api/role/{roleId}/knowledge/status', {
          params: { path: { roleId } },
        }),
      ),
  });

export const useRoleKnowledgeSearch = (roleId: string, query: string) =>
  useQuery({
    queryKey: queryKeys.roleKnowledgeSearch(roleId, query),
    queryFn: () =>
      unwrap(
        api.GET('/api/role/{roleId}/knowledge/query', {
          params: { path: { roleId }, query: { q: query } },
        }),
      ),
  });

export const useCompanyKnowledge = (companyId: string) =>
  useQuery({
    queryKey: queryKeys.companyKnowledge(companyId),
    queryFn: () =>
      unwrap(
        api.GET('/api/company/{companyId}/knowledge', {
          params: { path: { companyId } },
        }),
      ),
  });

export const useCompanyKnowledgeStatus = (companyId: string) =>
  useQuery({
    queryKey: queryKeys.companyKnowledgeStatus(companyId),
    queryFn: () =>
      unwrap(
        api.GET('/api/company/{companyId}/knowledge/status', {
          params: { path: { companyId } },
        }),
      ),
  });

// The write half of the file: one mutation hook per REST route that changes
// something, mirroring the read half above.

/**
 * Starts a chat-mode agent. The chat *assignment* is created for it
 * server-side — this only starts the agent that will hold it.
 */
export const useStartChatMutation = () =>
  useMutation({
    mutationFn: (body: { companyId: string; roleId: string }) =>
      unwrap(api.POST('/api/agent/chat/start', { body })),
  });

/**
 * Sends one message to a chat agent's ongoing conversation.
 *
 * The reply does not come back in this response — the turn runs detached and
 * its output arrives on the agent's event stream, so a caller must already be
 * watching that stream before calling this.
 */
export const useSendMessageMutation = (id: string) =>
  useMutation({
    mutationFn: (message: string) =>
      expectAccepted(
        api.POST('/api/agent/{id}/message', {
          params: { path: { id } },
          body: { message },
        }),
      ),
  });

/**
 * Ends a chat: its assignment succeeds and its agent completes.
 *
 * `unwrap`, not `expectAccepted` — nothing is dispatched, so the route answers
 * with the agent already in its new state rather than a bare `202`.
 */
export const useCompleteChatMutation = (id: string) =>
  useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/agent/{id}/complete', { params: { path: { id } } }),
      ),
  });

/**
 * Cancels a task: it moves to `cancelled`, and the server cascades that to its
 * still-running assignments and their agents.
 *
 * `unwrap`, not `expectAccepted` — the route answers `202` but with the
 * cancelled task as its body, and `unwrap` accepts any `ok` response that
 * carries one.
 */
export const useCancelTaskMutation = (id: string) =>
  useMutation({
    mutationFn: () =>
      unwrap(api.POST('/api/task/{id}/cancel', { params: { path: { id } } })),
  });

/**
 * Creates a task in the `ready` state. Starting it is a separate call, and
 * materials can only be uploaded before it is started.
 *
 * The one mutation here that does not go through {@link unwrap}: it has to
 * reach the response's headers for the soft warnings, and `unwrap` returns the
 * body alone. The failure path is `unwrap`'s, so an error still arrives as an
 * `ApiError` like every other.
 */
export const useCreateTaskMutation = () =>
  useMutation({
    mutationFn: async (body: components['schemas']['CreateTaskDto']) => {
      let result;
      try {
        result = await api.POST('/api/task', { body });
      } catch (cause) {
        // The request never landed — same reasoning as `unwrap`'s catch.
        throw networkError(cause);
      }

      const { data, error, response } = result;
      if (!response.ok || data === undefined) throw apiError(response, error);

      return { task: data, warnings: readWarnings(response) };
    },
  });

/**
 * Starts a task: the planner runs and assignments are fanned out from it.
 *
 * `unwrap`, not `expectAccepted` — the route answers `202` but with the task
 * as its body, the same shape as cancel above.
 */
export const useStartTaskMutation = () =>
  useMutation({
    mutationFn: (id: string) =>
      unwrap(api.POST('/api/task/{id}/start', { params: { path: { id } } })),
  });

/** Pauses a running task: its agents stop after their current step. */
export const usePauseTaskMutation = (id: string) =>
  useMutation({
    mutationFn: () =>
      unwrap(api.POST('/api/task/{id}/pause', { params: { path: { id } } })),
  });

/** Resumes a task a user paused, or one held by a cap, shutdown or rate limit. */
export const useResumeTaskMutation = (id: string) =>
  useMutation({
    mutationFn: () =>
      unwrap(api.POST('/api/task/{id}/resume', { params: { path: { id } } })),
  });

/** Changes a `ready` task's request, planner or expected outputs. */
export const useUpdateTaskMutation = (id: string) =>
  useMutation({
    mutationFn: (body: components['schemas']['UpdateTaskDto']) =>
      unwrap(api.PUT('/api/task/{id}', { params: { path: { id } }, body })),
  });

/**
 * Uploads one file to a task. Refused once the task has left `ready`.
 *
 * Goes through {@link postFile} rather than {@link api} — see its own note for
 * why a `File` cannot travel through the generated body type.
 */
export const useUploadMaterialMutation = () =>
  useMutation({
    mutationFn: ({ id, file }: { id: string; file: File }) =>
      postFile(`/api/task/${id}/materials`, file),
  });

/**
 * Answers an enquiry, which closes it and resumes the agent that asked.
 *
 * The resume is a side effect the server fires and forgets, so this returning
 * does not mean the agent has picked up again — only that the answer was
 * recorded. Refused with a `409` when the conversation is already closed.
 *
 * `authorIdentifier` is deliberately not sent. The server knows who the caller
 * is from the bearer token, and a client-supplied identifier beside it is a
 * second answer to the same question that can disagree.
 */
export const useReplyToEnquiryMutation = (slug: string) =>
  useMutation({
    mutationFn: (content: string) =>
      unwrap(
        api.POST('/api/conversation/{slug}/reply', {
          params: { path: { slug } },
          body: { content },
        }),
      ),
  });

/** Application-wide usage totals and every configured provider's cap progress. */
export const useSpendOverview = () =>
  useQuery({
    queryKey: queryKeys.spendOverview(),
    queryFn: () => unwrap(api.GET('/api/spend')),
  });

/** One company's usage totals, per-task breakdown and recent series. */
export const useCompanySpend = (companyId: string) =>
  useQuery({
    queryKey: queryKeys.companySpend(companyId),
    queryFn: () =>
      unwrap(
        api.GET('/api/company/{id}/spend', {
          params: { path: { id: companyId } },
        }),
      ),
  });

/** Active notifications, newest first. */
export const useNotifications = () =>
  useQuery({
    queryKey: queryKeys.notifications(),
    queryFn: () => unwrap(api.GET('/api/notifications')),
  });

/** Dismisses a notification for every user. */
export const useDismissNotificationMutation = () =>
  useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.POST('/api/notifications/{id}/dismiss', {
          params: { path: { id } },
        }),
      ),
  });

/**
 * Resumes a company's agents paused by a spend cap or a shutdown, and exempts
 * their tasks from spend caps until they end.
 *
 * `unwrap`, not `expectAccepted` — the route answers `202` but with the
 * resume count as its body, the same shape as cancel/start task above.
 */
export const useResumeCompanyMutation = (companyId: string) =>
  useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/company/{id}/resume', {
          params: { path: { id: companyId } },
        }),
      ),
  });
