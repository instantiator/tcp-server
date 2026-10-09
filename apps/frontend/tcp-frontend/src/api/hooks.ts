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

import {
  useMutation,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';

import type {
  AgentDTO,
  AssignmentDTO,
  CompanySpendDTO,
  ConversationDetailDTO,
  ConversationDTO,
  KnowledgeDocumentDTO,
  NotificationDTO,
  RoleDTO,
  SpendOverviewDTO,
  TaskDetailDTO,
  TaskDTO,
} from './dtos';
import {
  useAgent,
  useAgentByAssignment,
  useAgents,
  useAssignment,
  useAssignments,
  useCancelTaskMutation,
  useCloseTaskVisualisationMutation,
  usePauseTaskMutation,
  useResumeTaskMutation,
  useUpdateTaskMutation,
  useCompany,
  useCompanyKnowledge,
  useCompanyRoles,
  useCompanySpend,
  useCompleteChatMutation,
  useConversation,
  useConversations,
  useCreateTaskMutation,
  useDismissNotificationMutation,
  useNotifications,
  useReplyToEnquiryMutation,
  useResumeCompanyMutation,
  useRole,
  useSpendOverview,
  useStartChatMutation,
  useStartTaskMutation,
  useTask,
  useTasks,
  useUploadMaterialMutation,
} from './endpoints';
import type { components } from './schema';

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

export const useLiveCompanyAgentsList = (
  companyId: string,
): UseQueryResult<AgentDTO[], Error> => useAgents({ companyId });

export const useLiveCompanyTasksList = (
  companyId: string,
): UseQueryResult<TaskDTO[], Error> => useTasks({ companyId });

/** Chats are assignments in `chat` mode. There is no chat route. */
export const useLiveCompanyChatsList = (
  companyId: string,
): UseQueryResult<AssignmentDTO[], Error> =>
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
export const useLiveCompanyConsultationsList = (
  companyId: string,
): UseQueryResult<AssignmentDTO[], Error> =>
  useAssignments({ companyId, taskId: 'null', mode: 'consultee' });

export const useLiveCompanyEnquiriesList = (
  companyId: string,
  status?: string,
): UseQueryResult<ConversationDTO[], Error> =>
  useConversations({ companyId, status });

/** Not live: nothing streams a role. */
export const useCompanyRolesList = (
  companyId: string,
): UseQueryResult<RoleDTO[], Error> => useCompanyRoles(companyId);

/** Not live: nothing streams a knowledge index. */
export const useCompanyKnowledgeList = (
  companyId: string,
): UseQueryResult<KnowledgeDocumentDTO[], Error> =>
  useCompanyKnowledge(companyId);

/** Any combination of the three ids an assignment can be reached through. */
export interface AssignmentFilter {
  readonly companyId?: string;
  readonly taskId?: string;
  readonly roleId?: string;
}

export const useLiveAssignmentsList = (
  filter: AssignmentFilter,
): UseQueryResult<AssignmentDTO[], Error> => useAssignments(filter);

/**
 * One task.
 *
 * `data` carries the task's own fields at the top level, plus `assignments`
 * — the assignments working it. `TaskController.getTask` returns the shape
 * flattened rather than wrapped, because the live-event cache patches a
 * cached row by matching its top-level `id`, and a wrapper has none.
 */
export const useLiveTaskState = (
  taskId: string,
): UseQueryResult<TaskDetailDTO, Error> => useTask(taskId);

/**
 * A chat, which is an assignment in `chat` mode.
 *
 * The value is the assignment, not the conversation: the messages are not on
 * it. Read the transcript with `useAgentHistory` for the agent holding this
 * assignment, which `useLiveAgentState({ assignmentId })` will find.
 */
export const useLiveChatState = (
  assignmentId: string,
): UseQueryResult<AssignmentDTO, Error> => useAssignment(assignmentId);

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
 * Closes a finished task's room in the office view. Invalidates the task
 * lists, so the live `visualisationClosedAt` reaches the office rules.
 */
export const useCloseTaskVisualisation = (taskId: string) => {
  const queryClient = useQueryClient();
  const closeVisualisation = useCloseTaskVisualisationMutation(taskId);
  return useMutation({
    mutationFn: () => closeVisualisation.mutateAsync(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task'] });
    },
  });
};

/**
 * Starts a `ready` task. The same endpoint {@link useCreateTask} calls after
 * creating one; invalidates as {@link useCancelTask} does, because starting
 * fans the task out into assignments.
 */
export const useStartTask = (taskId: string) => {
  const queryClient = useQueryClient();
  const startTask = useStartTaskMutation();
  return useMutation({
    mutationFn: () => startTask.mutateAsync(taskId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task'] });
      void queryClient.invalidateQueries({ queryKey: ['assignment'] });
    },
  });
};

/**
 * Pauses a task. Agents stop after their current step, so their rows change
 * too — hence `['agent']` as well as the task keys.
 */
export const usePauseTask = (taskId: string) => {
  const queryClient = useQueryClient();
  const pauseTask = usePauseTaskMutation(taskId);
  return useMutation({
    mutationFn: () => pauseTask.mutateAsync(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task'] });
      void queryClient.invalidateQueries({ queryKey: ['assignment'] });
      void queryClient.invalidateQueries({ queryKey: ['agent'] });
    },
  });
};

/** Resumes a task; its paused agents pick up again, so agents are refetched. */
export const useResumeTask = (taskId: string) => {
  const queryClient = useQueryClient();
  const resumeTask = useResumeTaskMutation(taskId);
  return useMutation({
    mutationFn: () => resumeTask.mutateAsync(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task'] });
      void queryClient.invalidateQueries({ queryKey: ['assignment'] });
      void queryClient.invalidateQueries({ queryKey: ['agent'] });
    },
  });
};

/** Edits a `ready` task. The server refuses with a `409` once it has started. */
export const useUpdateTask = (taskId: string) => {
  const queryClient = useQueryClient();
  const updateTask = useUpdateTaskMutation(taskId);
  return useMutation({
    mutationFn: (body: components['schemas']['UpdateTaskDto']) =>
      updateTask.mutateAsync(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task'] });
    },
  });
};

/** What the creation dialog collects, before any of it reaches a route. */
export interface CreateTaskInput {
  readonly companyId: string;
  readonly request: string;
  readonly plannerRoleId?: string;
  /** Filenames the task is expected to produce. */
  readonly expected?: readonly string[];
  /** Files to attach. Uploaded one at a time, after the task exists. */
  readonly files: readonly File[];
  /** Whether to start the task once it is created and its files are on it. */
  readonly start: boolean;
}

/** What happened, in enough detail for the dialog to say so honestly. */
export interface CreateTaskResult {
  readonly task: components['schemas']['TaskResponseDto'];
  readonly warnings: readonly string[];
  /** Names of files that did not attach. Empty when everything landed. */
  readonly failedUploads: readonly string[];
  readonly started: boolean;
}

/**
 * Creates a task, attaches its files, and optionally starts it.
 *
 * One facade over three routes rather than three hooks, because the calls are
 * ordered and a later one is meaningless without the earlier: the server
 * refuses a material once the task has left `ready`, so every file has to land
 * before the start.
 *
 * **A failed upload does not fail the mutation and does not undo the task.**
 * There is no way to un-create it, so pretending the whole thing failed would
 * be a lie the user then has to discover. It resolves with the names that did
 * not attach, and skips the start — a task that was meant to have its files is
 * better left in `ready`, where they can still be added, than started without
 * them.
 *
 * Uploads run one at a time. A parallel burst against a single task is load
 * nobody asked for, and it makes "which ones failed" depend on timing.
 */
export const useCreateTask = () => {
  const queryClient = useQueryClient();
  const createTask = useCreateTaskMutation();
  const uploadMaterial = useUploadMaterialMutation();
  const startTask = useStartTaskMutation();

  return useMutation({
    mutationFn: async (input: CreateTaskInput): Promise<CreateTaskResult> => {
      const { task, warnings } = await createTask.mutateAsync({
        companyId: input.companyId,
        request: input.request,
        ...(input.plannerRoleId === undefined
          ? {}
          : { plannerRoleId: input.plannerRoleId }),
        ...(input.expected === undefined || input.expected.length === 0
          ? {}
          : {
              expected: input.expected.map((value) => ({
                type: 'task-completed-path' as const,
                value,
              })),
            }),
      });

      const failedUploads: string[] = [];
      for (const file of input.files) {
        try {
          await uploadMaterial.mutateAsync({ id: task.id, file });
        } catch {
          // Collected rather than thrown: the task exists either way, and the
          // dialog has to be able to name every file that did not make it.
          failedUploads.push(file.name);
        }
      }

      const started = input.start && failedUploads.length === 0;
      if (started) await startTask.mutateAsync(task.id);

      return { task, warnings, failedUploads, started };
    },
    onSuccess: () => {
      // Both keys, as {@link useCancelTask} does: starting a task fans it out
      // into assignments, and the lists holding either have to agree.
      void queryClient.invalidateQueries({ queryKey: ['task'] });
      void queryClient.invalidateQueries({ queryKey: ['assignment'] });
    },
  });
};

/**
 * Answers an enquiry, and makes every list holding it agree.
 *
 * Only `['enquiry']` is invalidated. The agent resuming arrives on the
 * company's event stream and patches the cache without help — invalidating
 * `['agent']` too would be a second, slower source of the same truth.
 */
export const useReplyToEnquiry = (slug: string) => {
  const queryClient = useQueryClient();
  const reply = useReplyToEnquiryMutation(slug);
  return useMutation({
    mutationFn: (content: string) => reply.mutateAsync(content),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['enquiry'] });
    },
  });
};

/**
 * A consultation, which is an assignment in `consultee` mode.
 *
 * Only resolves once the consultation has been picked up — before that there
 * is no assignment row, and so no id to pass here (ADR-023).
 */
export const useLiveConsultationState = (
  assignmentId: string,
): UseQueryResult<AssignmentDTO, Error> => useAssignment(assignmentId);

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
export const useLiveEnquiryState = (
  slug: string,
): UseQueryResult<ConversationDetailDTO, Error> => useConversation(slug);

/** Not live: nothing streams a role. */
export const useRoleState = (roleId: string): UseQueryResult<RoleDTO, Error> =>
  useRole(roleId);

/**
 * Application-wide usage totals and every provider's cap progress.
 *
 * A usage write patches no cache row — it carries no `entity`-matching id —
 * so a `spend` event always invalidates (`applyEvent` in `src/events/cache.ts`).
 * That keeps the breadcrumb bars current on any page holding the company
 * event stream open, not just the one that caused the usage.
 */
export const useLiveSpendOverview = (): UseQueryResult<
  SpendOverviewDTO,
  Error
> => useSpendOverview();

/** One company's usage totals, per-task breakdown and recent series. */
export const useLiveCompanySpend = (
  companyId: string,
): UseQueryResult<CompanySpendDTO, Error> => useCompanySpend(companyId);

/**
 * A company's active notifications (its own and the application-wide ones),
 * newest first.
 *
 * Server-filtered to active rows (`includeDismissed` defaults to false), and
 * every caller re-filters on `dismissedAt` again, client-side — the same
 * shape as {@link useLiveCompanyEnquiriesList}'s callers, and for the same
 * reason: a dismissal arrives as a live patch to the row in place, not as its
 * removal from the array, so the query's own filter only describes what was
 * true when it was fetched.
 */
export const useLiveNotifications = (
  companyId: string,
): UseQueryResult<NotificationDTO[], Error> => useNotifications(companyId);

/**
 * Dismisses a notification for every signed-in user, and makes every list
 * holding it agree without waiting on the live event the server also sends —
 * the same reasoning as {@link useReplyToEnquiry}'s invalidation.
 */
export const useDismissNotification = () => {
  const queryClient = useQueryClient();
  const dismiss = useDismissNotificationMutation();
  return useMutation({
    mutationFn: (id: string) => dismiss.mutateAsync(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notification'] });
    },
  });
};

/**
 * Resumes a company's agents paused by a spend cap or a shutdown, and exempts
 * their tasks from spend caps until they end.
 */
export const useResumeCompany = (companyId: string) => {
  const resume = useResumeCompanyMutation(companyId);
  return useMutation({
    mutationFn: () => resume.mutateAsync(),
  });
};

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
export const useLiveAgentState = ({
  agentId,
  assignmentId,
}: AgentLookup): UseQueryResult<AgentDTO | null, Error> => {
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
