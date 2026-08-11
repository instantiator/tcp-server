/**
 * The hooks a component uses to read company data (ADR-030).
 *
 * This is the only data door for a view. `endpoints.ts` sits behind it, one
 * hook per REST route, and an eslint rule keeps it there.
 *
 * **`Live` means the value is pushed to the browser and updates itself.** An
 * event arrives over SSE, `applyEvent` patches the shared query cache, and
 * every `useLive*` hook reading that cache re-renders. A hook without the
 * prefix answers once and refetches only when asked: `role`, `company-user`
 * and `knowledge` are `STATIC_ENTITIES` in `query-keys.ts`, and nothing
 * streams them. `useCompanies` has no prefix for a different reason — there is
 * no company-list stream, only a channel per company.
 *
 * **No hook here opens a stream.** The page owns the one subscription
 * (`CompanyPage` calls `useEventStream`); these hooks only read what it
 * patches. An illustrated view could call `useLiveAgentState` once per avatar,
 * and if each opened a connection that is the `MAX_STREAMS` cap in
 * `subscriptions.ts`, not a facade.
 *
 * **The door covers writes too.** A component gets its mutations from here as
 * well as its queries — `endpoints.ts` is still the only place a request is
 * described, but a component never imports it directly.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
  useAgent,
  useAgentByAssignment,
  useAgents,
  useAssignment,
  useAssignments,
  useCancelTaskMutation,
  useCompany,
  useCompanyKnowledge,
  useCompanyRoles,
  useCompleteChatMutation,
  useConversation,
  useConversations,
  useRole,
  useStartChatMutation,
  useTask,
  useTasks,
} from './endpoints';

export { useCompanies } from './endpoints';

/**
 * One company.
 *
 * Deliberately a plain alias: `GET /api/company/{id}` answers 200 with a JSON
 * `null` for a company the caller cannot see, and this hook does not fold that
 * into `undefined` — rewrapping the result would cost the narrowing TanStack
 * gives (`isSuccess` implying `data` is present) to save one line at the call
 * site. `CompanyPage` handles it, with a comment.
 */
export const useLiveCompanyState = (companyId: string) => useCompany(companyId);

export const useLiveCompanyAgentsList = (companyId: string) =>
  useAgents({ companyId });

export const useLiveCompanyTasksList = (companyId: string) =>
  useTasks({ companyId });

/** Chats are assignments in `chat` mode. There is no chat route. */
export const useLiveCompanyChatsList = (companyId: string) =>
  useAssignments({ companyId, mode: 'chat' });

/**
 * Open consultations: assignments in `consultee` mode with no task (ADR-023).
 *
 * `taskId` is the literal four-character string `'null'`, not JS `null` — the
 * server's `AssignmentController` tests for it and maps it to `IsNull()`.
 * Omitting it would mean "any task" instead of "no task". This looks like a
 * bug and is not one.
 *
 * Incomplete by design: a consultation that has been requested but not yet
 * picked up has no assignment row, so it cannot appear here. A view using this
 * must say so — `t('activity.consultations.partial')` is the wording.
 */
export const useLiveCompanyConsultationsList = (companyId: string) =>
  useAssignments({ companyId, taskId: 'null', mode: 'consultee' });

export const useLiveCompanyEnquiriesList = (
  companyId: string,
  status?: string,
) => useConversations({ companyId, status });

/** Not live: nothing streams a role. */
export const useCompanyRolesList = (companyId: string) =>
  useCompanyRoles(companyId);

/** Not live: nothing streams a knowledge index. */
export const useCompanyKnowledgeList = (companyId: string) =>
  useCompanyKnowledge(companyId);

/** Any combination of the three ids an assignment can be reached through. */
export interface AssignmentFilter {
  readonly companyId?: string;
  readonly taskId?: string;
  readonly roleId?: string;
}

export const useLiveAssignmentsList = (filter: AssignmentFilter) =>
  useAssignments(filter);

/**
 * One task.
 *
 * `data` carries the task's own fields at the top level, plus `assignments`
 * — the assignments working it. `TaskController.getTask` returns the shape
 * flattened rather than wrapped, because the live-event cache patches a
 * cached row by matching its top-level `id`, and a wrapper has none.
 */
export const useLiveTaskState = (taskId: string) => useTask(taskId);

/**
 * A chat, which is an assignment in `chat` mode.
 *
 * The value is the assignment, not the conversation: the messages are not on
 * it. Read the transcript with `useAgentHistory` for the agent holding this
 * assignment, which `useLiveAgentState({ assignmentId })` will find.
 */
export const useLiveChatState = (assignmentId: string) =>
  useAssignment(assignmentId);

/**
 * Starts a chat-mode agent and makes the new chat show up.
 *
 * Chat-mode assignments are **not** primed on the company event stream —
 * only `consultee` ones are (`CompanyPrimingService.prime` in the backend) —
 * so a freshly started chat would sit invisible in a chats list until
 * something else happened to refetch it. This wraps
 * {@link useStartChatMutation} rather than redefining its request — the call
 * to tcp-server stays described in exactly one place — and invalidates the
 * assignment queries on success so the new chat appears.
 */
export const useStartChat = () => {
  const queryClient = useQueryClient();
  const startChat = useStartChatMutation();
  return useMutation({
    // Wrapped in an arrow rather than passed by reference: `mutateAsync` takes
    // a second argument of its own, and handing it straight over would let
    // TanStack call it with a `MutationFunctionContext` it cannot use.
    mutationFn: (body: { companyId: string; roleId: string }) =>
      startChat.mutateAsync(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['assignment'] });
    },
  });
};

/**
 * Ends a chat, and makes every list holding it agree.
 *
 * Wraps {@link useCompleteChatMutation} the same way {@link useStartChat}
 * wraps its own: the request stays described in `endpoints.ts`, and the
 * invalidation lives here. The agent's own `completed` status arrives on its
 * event stream and patches the cache without help — but the **assignment**
 * moving to `succeeded` does not, so a chats list would keep showing this one
 * as open until something else refetched it.
 */
export const useCompleteChat = (agentId: string) => {
  const queryClient = useQueryClient();
  const completeChat = useCompleteChatMutation(agentId);
  return useMutation({
    mutationFn: () => completeChat.mutateAsync(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['assignment'] });
    },
  });
};

/**
 * Cancels a task, and makes every list holding it agree.
 *
 * Both keys are invalidated because the server cascades: the task moves to
 * `cancelled` and so does every assignment still working it. The task's own
 * change arrives on its event stream, but the assignments' do not all carry a
 * summary, so a refetch is what keeps the panels honest.
 *
 * The server refuses a task that is already terminal with a `409`. The
 * control is hidden for those statuses, so this is a race rather than an
 * ordinary path — it still surfaces through `isError`.
 */
export const useCancelTask = (taskId: string) => {
  const queryClient = useQueryClient();
  const cancelTask = useCancelTaskMutation(taskId);
  return useMutation({
    mutationFn: () => cancelTask.mutateAsync(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task'] });
      void queryClient.invalidateQueries({ queryKey: ['assignment'] });
    },
  });
};

/**
 * A consultation, which is an assignment in `consultee` mode.
 *
 * Only resolves once the consultation has been picked up — before that there
 * is no assignment row, and so no id to pass here (ADR-023).
 */
export const useLiveConsultationState = (assignmentId: string) =>
  useAssignment(assignmentId);

/**
 * One enquiry, by slug.
 *
 * A slug rather than an id, unlike its siblings: `GET /api/conversation` has
 * no by-id route, only `/{slug}`. The event summary does carry an id, and
 * `applyEvent` matches on the cached value rather than the key, so this row is
 * patched like any other.
 *
 * `data` carries the conversation's own fields at the top level, plus
 * `messages` and `companyTimezone`. `ConversationController.get` returns the
 * shape flattened, for the same reason as {@link useLiveTaskState}: the cache
 * patches by top-level `id`.
 */
export const useLiveEnquiryState = (slug: string) => useConversation(slug);

/** Not live: nothing streams a role. */
export const useRoleState = (roleId: string) => useRole(roleId);

/** The two ids an agent can be reached through. */
export interface AgentLookup {
  readonly agentId?: string;
  readonly assignmentId?: string;
}

/**
 * One agent, found by either id it can be reached through. Agent and
 * assignment are 1:1, so both answers are the same agent.
 *
 * `agentId` wins if both are given. With neither, the hook stays disabled and
 * never fetches. Looked up by `assignmentId`, `data` is `null` rather than
 * `undefined` when no agent holds it.
 *
 * Both lookups run every render, because a hook cannot be called
 * conditionally; the unused one is disabled, so only one request is made.
 */
export const useLiveAgentState = ({ agentId, assignmentId }: AgentLookup) => {
  const byAgentId = useAgent(agentId ?? '', agentId !== undefined);
  const byAssignmentId = useAgentByAssignment(
    assignmentId ?? '',
    agentId === undefined && assignmentId !== undefined,
  );
  return agentId === undefined ? byAssignmentId : byAgentId;
};

// The endpoint hooks with no facade above, re-exported so hooks.ts is a
// complete door and nothing has a reason to reach past it.
export {
  useAgentHistory,
  useCompanyKnowledgeStatus,
  useCompanyUsers,
  useRoleBySlug,
  useRoleKnowledge,
  useRoleKnowledgeSearch,
  useRoleKnowledgeStatus,
  useSendMessageMutation as useSendMessage,
  useTaskHistory,
} from './endpoints';
