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
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useMemo } from 'react';

import type {
  AgentDTO,
  AssignmentDTO,
  CompanySpendDTO,
  ConversationDetailDTO,
  ConversationDTO,
  KnowledgeDocumentDTO,
  RecordTableDefinition,
  RecordSearchResult,
  RecordTableRetention,
  RecordTableRows,
  TimedRecord,
  NotificationDTO,
  RoleDTO,
  SpendOverviewDTO,
  TaskDetailDTO,
  TaskDTO,
} from './dtos';
import {
  compareRows,
  NO_ROW_CHANGES,
  type RowChanges,
  sameColumns,
} from './compareRows';
import {
  forgetLatestRecords,
  keyParams,
  latestSearches,
  type LatestRecordTable,
} from './record-changes';
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
  useCompanyKnowledgeSearch,
  useCompanyKnowledgeStatus,
  useCreateCompanyMutation,
  useCreateRoleMutation,
  useDeleteCompanyMutation,
  useDeleteKnowledgeMutation,
  useDeleteRoleMutation,
  useReindexKnowledgeMutation,
  useRoleKnowledge,
  useRoleKnowledgeSearch,
  useRoleKnowledgeStatus,
  useUpdateRoleMutation,
  useUpdateCompanyMutation,
  useUploadKnowledgeMutation,
  type KnowledgeScope,
  useAddRecordMutation,
  useAppendRecordsCsvMutation,
  useClearRecordTableMutation,
  useDeleteRecordMutation,
  useDropRecordTableMutation,
  useAddColumnMutation,
  useRenameColumnMutation,
  useDeleteColumnMutation,
  useSetPrimaryKeyMutation,
  useAddUniqueKeyMutation,
  useDropUniqueKeyMutation,
  useRetypeColumnMutation,
  useRecordTable,
  useRecordTables,
  useUpdateRecordMutation,
  useAddDoNotStoreMutation,
  useDeleteRecordsAcrossMutation,
  useDeleteRecordsMutation,
  useDoNotStoreList,
  useRecordSearch,
  useRemoveDoNotStoreMutation,
  useSetRetentionMutation,
  useUpdateDoNotStoreMutation,
  type DoNotStoreConfirmation,
  getBlob,
  postJsonForBlob,
  recordTableCsvPath,
  recordsExportPath,
  recordsSelectionExportPath,
  useCompanyRoles,
  useCompanySpend,
  useCompleteChatMutation,
  useConversation,
  useConversations,
  useCreateTaskMutation,
  useDeleteChatMutation,
  useDismissNotificationMutation,
  useNotifications,
  useReplyToEnquiryMutation,
  useResumeCompanyMutation,
  useRole,
  useSpendOverview,
  useStartChatMutation,
  useStartTaskMutation,
  useBeginShutdownMutation,
  useCancelShutdownMutation,
  useShutdownStatusQuery,
  useSystemHealthQuery,
  useSystemStatusQuery,
  useTask,
  useTasks,
  useUploadMaterialMutation,
} from './endpoints';
import { recordsDownloadName } from '@tcp/shared/client';

import { queryKeys } from './query-keys';
import type { components } from './schema';
import { useSession } from '../auth/useSession';

export { useCompanies } from './endpoints';

/**
 * Whether the caller is an administrator, and the shutdown state. Not live:
 * the answer rarely changes, so it is never stale and a failure is not retried
 * (a failed call just means no System menu). `options` lets a caller poll.
 *
 * Asks only once signed in: the route needs a token, and a 401 is a
 * full-page sign-in redirect, which would bounce a signed-out visitor off a
 * public page.
 */
export const useSystemStatus = (
  options: Parameters<typeof useSystemStatusQuery>[0] = {},
) => {
  const signedIn = useSession() !== null;
  return useSystemStatusQuery({
    staleTime: Infinity,
    retry: false,
    ...options,
    enabled: signedIn && (options.enabled ?? true),
  });
};

/** How often the shutdown dialog asks while something is happening. */
const SHUTDOWN_POLL_MS = 2_000;

/**
 * The shutdown state, while the shutdown dialog is open.
 *
 * Polls while a drain is under way, and while the server is unreachable after
 * a restart was seen (it is down and coming back). TanStack keeps the last good
 * answer through a failed refetch, which is how "after a restart was seen" is
 * known. Idle, or at rest without a restart, nothing changes by itself.
 */
export const useShutdownStatus = (enabled: boolean) =>
  useShutdownStatusQuery({
    enabled,
    retry: false,
    refetchInterval: (query) => {
      if (!enabled) return false;
      const { data, status } = query.state;
      if (status === 'error') return data?.restart === true && SHUTDOWN_POLL_MS;
      if (data === undefined || data.state === 'idle') return false;
      // At rest without a restart, nothing more happens by itself.
      return (data.state === 'draining' || data.restart) && SHUTDOWN_POLL_MS;
    },
  });

/**
 * Starts a shutdown or restart. The answer is the new state, so it goes
 * straight into the cache; the system status carries the same state for the
 * banner.
 */
export const useBeginShutdown = () => {
  const queryClient = useQueryClient();
  const begin = useBeginShutdownMutation();
  return useMutation({
    mutationFn: (flags: { force: boolean; restart: boolean }) =>
      begin.mutateAsync(flags),
    onSuccess: (status) => {
      queryClient.setQueryData(queryKeys.shutdownStatus(), status);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.systemStatus(),
      });
    },
  });
};

/** Cancels a shutdown or restart that is still draining or at rest. */
export const useCancelShutdown = () => {
  const queryClient = useQueryClient();
  const cancel = useCancelShutdownMutation();
  return useMutation({
    mutationFn: () => cancel.mutateAsync(),
    onSuccess: (status) => {
      queryClient.setQueryData(queryKeys.shutdownStatus(), status);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.systemStatus(),
      });
    },
  });
};

/** The health of every service. Administrators only; refetched on request. */
export const useSystemHealth = useSystemHealthQuery;

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

/** How often knowledge status is asked while an index rebuild runs. */
const KNOWLEDGE_POLL_MS = 3_000;

/**
 * The scope's documents. Both reads are called to keep the hook order fixed;
 * the one for the other scope is disabled and never requests.
 */
export const useKnowledgeList = (scope: KnowledgeScope) => {
  const role = useRoleKnowledge(scope.kind === 'role' ? scope.roleId : '', {
    enabled: scope.kind === 'role',
  });
  const company = useCompanyKnowledge(
    scope.kind === 'company' ? scope.companyId : '',
    { enabled: scope.kind === 'company' },
  );
  return scope.kind === 'role' ? role : company;
};

/** Semantic search over the scope's knowledge; idle while the query is blank. */
export const useKnowledgeSearch = (scope: KnowledgeScope, query: string) => {
  const searching = query.trim() !== '';
  const role = useRoleKnowledgeSearch(
    scope.kind === 'role' ? scope.roleId : '',
    query,
    { enabled: scope.kind === 'role' && searching },
  );
  const company = useCompanyKnowledgeSearch(
    scope.kind === 'company' ? scope.companyId : '',
    query,
    { enabled: scope.kind === 'company' && searching },
  );
  return scope.kind === 'role' ? role : company;
};

/**
 * The scope's index status. Nothing streams a knowledge index (`knowledge` is
 * a `STATIC_ENTITIES` kind), so it is polled while a rebuild runs, and not
 * otherwise. For the company scope the answer is its shared index.
 */
export const useKnowledgeStatus = (scope: KnowledgeScope) => {
  const role = useRoleKnowledgeStatus(
    scope.kind === 'role' ? scope.roleId : '',
    {
      enabled: scope.kind === 'role',
      refetchInterval: (query) =>
        query.state.data?.indexing === true && KNOWLEDGE_POLL_MS,
    },
  );
  const company = useCompanyKnowledgeStatus(
    scope.kind === 'company' ? scope.companyId : '',
    {
      enabled: scope.kind === 'company',
      select: (status) => status.shared,
      refetchInterval: (query) =>
        query.state.data?.shared.indexing === true && KNOWLEDGE_POLL_MS,
    },
  );
  return scope.kind === 'role' ? role : company;
};

/**
 * The success handler for a knowledge mutation: every knowledge cache refetches.
 * The request itself stays described in `endpoints.ts`.
 */
const useKnowledgeInvalidation = () => {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['knowledge'] });
  };
};

/** Uploads a knowledge file; the lists and status refetch on success. */
export const useUploadKnowledge = (scope: KnowledgeScope) => {
  const upload = useUploadKnowledgeMutation(scope);
  return useMutation({
    mutationFn: (input: { file: File; signal?: AbortSignal }) =>
      upload.mutateAsync(input),
    onSuccess: useKnowledgeInvalidation(),
  });
};

/** Deletes a knowledge file; the lists and status refetch on success. */
export const useDeleteKnowledge = (scope: KnowledgeScope) => {
  const remove = useDeleteKnowledgeMutation(scope);
  return useMutation({
    mutationFn: (filename: string) => remove.mutateAsync(filename),
    onSuccess: useKnowledgeInvalidation(),
  });
};

/**
 * Starts a rebuild. The refetch shows the status as `indexing`, and
 * {@link useKnowledgeStatus} polls from there until it finishes.
 */
export const useReindexKnowledge = (scope: KnowledgeScope) => {
  const reindex = useReindexKnowledgeMutation(scope);
  return useMutation({
    mutationFn: () => reindex.mutateAsync(),
    onSuccess: useKnowledgeInvalidation(),
  });
};

/** Creates a role; the role lists refetch (nothing streams roles). */
export const useCreateRole = () => {
  const queryClient = useQueryClient();
  const create = useCreateRoleMutation();
  return useMutation({
    mutationFn: (body: Parameters<typeof create.mutateAsync>[0]) =>
      create.mutateAsync(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['role'] });
    },
  });
};

/** Edits a role; the role lists and details refetch (nothing streams roles). */
export const useUpdateRole = () => {
  const queryClient = useQueryClient();
  const update = useUpdateRoleMutation();
  return useMutation({
    mutationFn: (input: Parameters<typeof update.mutateAsync>[0]) =>
      update.mutateAsync(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['role'] });
    },
  });
};

/**
 * Edits a company. Its own detail refetches; so does knowledge, since a new
 * embedding model starts a re-index.
 */
export const useUpdateCompany = () => {
  const queryClient = useQueryClient();
  const update = useUpdateCompanyMutation();
  return useMutation({
    mutationFn: (input: Parameters<typeof update.mutateAsync>[0]) =>
      update.mutateAsync(input),
    onSuccess: () => {
      for (const queryKey of [['company'], ['knowledge']]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
};

/** Creates a company; the companies list refetches (nothing streams it). */
export const useCreateCompany = () => {
  const queryClient = useQueryClient();
  const create = useCreateCompanyMutation();
  return useMutation({
    mutationFn: (body: Parameters<typeof create.mutateAsync>[0]) =>
      create.mutateAsync(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['company'] });
    },
  });
};

/**
 * Deletes a company. Its detail is dropped rather than refetched, which would
 * only 404; the companies list refetches.
 */
export const useDeleteCompany = () => {
  const queryClient = useQueryClient();
  const remove = useDeleteCompanyMutation();
  return useMutation({
    mutationFn: (id: string) => remove.mutateAsync(id),
    onSuccess: (_result, id) => {
      queryClient.removeQueries({ queryKey: queryKeys.company(id) });
      void queryClient.invalidateQueries({ queryKey: ['company'] });
    },
  });
};

/**
 * Deletes a role. Its knowledge files go with it, and a deleted planner clears
 * the company's `plannerRoleId`, so all three caches are stale.
 */
export const useDeleteRole = () => {
  const queryClient = useQueryClient();
  const remove = useDeleteRoleMutation();
  return useMutation({
    mutationFn: (id: string) => remove.mutateAsync(id),
    onSuccess: () => {
      for (const queryKey of [['role'], ['knowledge'], ['company']]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
};

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
 * Deletes a chat, and makes every list holding it agree.
 *
 * Both keys are invalidated: the chat's assignment and its agent are both
 * gone, and no live event announces a deletion.
 */
export const useDeleteChat = (agentId: string) => {
  const queryClient = useQueryClient();
  const deleteChat = useDeleteChatMutation(agentId);
  return useMutation({
    mutationFn: () => deleteChat.mutateAsync(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['assignment'] });
      void queryClient.invalidateQueries({ queryKey: ['agent'] });
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
  useCompanyUsers,
  useLlmDefaults,
  useLocalModelsQuery as useLocalModels,
  useMcpServers,
  useRoleBySlug,
  useSendMessageMutation as useSendMessage,
  useTaskHistory,
  useToolFootprintQuery as useToolFootprint,
  useTranscriptSearch,
} from './endpoints';

export type { LocalModelsQuery } from './endpoints';

export type { KnowledgeScope };

export { useDoNotStoreList, useRecordSearch, useRecordTable };

/**
 * The summary of every record table: name, purpose and row count. Live: a
 * change to any table elsewhere refetches it (001.05), so the tray and the
 * Tables tab stay current. Ordered by name, so a refetch never moves a row.
 */
export const useLiveRecordTables = useRecordTables;
export type { DoNotStoreConfirmation, RowChanges };
export { recordErrorBody, type RecordErrorBody } from './errors';

/**
 * Edits patch the cached table where it stands rather than refetching: a
 * refetch re-sorts newest-first and an edited row would jump under the user
 * (ADR-027). Only the summaries (row counts, updated time) are refetched.
 *
 * An edit patches the table's fresher copy too, when one has been read
 * (001.05), so a change made here is never reported as made elsewhere.
 */
const useRecordCache = (companyId: string, table: string) => {
  const queryClient = useQueryClient();
  const tableKey = queryKeys.recordTable(companyId, table);
  const edit = (change: (current: RecordTableRows) => RecordTableRows) => {
    queryClient.setQueryData<RecordTableRows>(tableKey, (current) =>
      current === undefined ? current : change(current),
    );
    queryClient.setQueryData<LatestRecordTable>(
      queryKeys.recordTableLatest(companyId, table),
      (current) => (current ? change(current) : current),
    );
    void queryClient.invalidateQueries({
      queryKey: queryKeys.recordTables(companyId),
    });
  };
  // A refused edit (often a 409) means the table moved on: reload it, and any
  // search showing its rows.
  const reload = () => {
    forgetLatestRecords(
      queryClient,
      companyId,
      (params) => params.table === table || latestSearches(params),
    );
    void queryClient.invalidateQueries({ queryKey: tableKey });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.recordTables(companyId),
    });
    void queryClient.invalidateQueries({ queryKey: ['record', 'search'] });
  };
  // A row changed from a search: replace it where it stands in every search
  // showing it, as an edit does in the table (ADR-027), and in their fresher
  // copies, as `edit` does.
  const replaceInSearches = (row: TimedRecord) => {
    const replace = (current: RecordSearchResult | undefined) =>
      current === undefined
        ? current
        : {
            ...current,
            groups: current.groups.map((group) =>
              group.definition.name !== table
                ? group
                : {
                    ...group,
                    rows: group.rows.map((r) => (r.id === row.id ? row : r)),
                  },
            ),
          };
    queryClient.setQueriesData<RecordSearchResult>(
      { queryKey: ['record', 'search'] },
      replace,
    );
    queryClient.setQueriesData<RecordSearchResult>(
      {
        queryKey: ['record', 'latest'],
        predicate: (query) => latestSearches(keyParams(query)),
      },
      replace,
    );
  };
  return { edit, reload, replaceInSearches };
};

/** Returns a function that runs a search again; its out-of-date notice's "Reload". */
export const useReloadRecordSearch = (companyId: string, q: string) => {
  const queryClient = useQueryClient();
  return () => {
    forgetLatestRecords(queryClient, companyId, latestSearches);
    void queryClient.invalidateQueries({
      queryKey: queryKeys.recordSearch(companyId, q),
    });
  };
};

/** Returns a function that reloads the open table; the UI's explicit "Reload". */
export const useReloadRecordTable = (companyId: string, table: string) =>
  useRecordCache(companyId, table).reload;

/** Adds a row at the start of the cached table. */
export const useAddRecord = (companyId: string, table: string) => {
  const { edit, reload } = useRecordCache(companyId, table);
  const add = useAddRecordMutation(companyId, table);
  return useMutation({
    mutationFn: (
      input: { data: Record<string, unknown> } & DoNotStoreConfirmation,
    ) => add.mutateAsync(input),
    onSuccess: (row: TimedRecord) =>
      edit((t) => ({ ...t, rows: [row, ...t.rows], total: t.total + 1 })),
    onError: reload,
  });
};

/** Replaces the edited row in the cached table, in the same position. */
export const useUpdateRecord = (companyId: string, table: string) => {
  const { edit, reload, replaceInSearches } = useRecordCache(companyId, table);
  const update = useUpdateRecordMutation(companyId, table);
  return useMutation({
    mutationFn: (
      input: {
        id: string;
        changes: Record<string, unknown>;
        version: number;
      } & DoNotStoreConfirmation,
    ) => update.mutateAsync(input),
    onSuccess: (row: TimedRecord) => {
      edit((t) => ({
        ...t,
        rows: t.rows.map((r) => (r.id === row.id ? row : r)),
      }));
      replaceInSearches(row);
    },
    onError: reload,
  });
};

/** Removes the row from the cached table and lowers its total. */
export const useDeleteRecord = (companyId: string, table: string) => {
  const { edit, reload } = useRecordCache(companyId, table);
  const remove = useDeleteRecordMutation(companyId, table);
  return useMutation({
    mutationFn: (input: { id: string; version: number }) =>
      remove.mutateAsync(input),
    onSuccess: (_result, { id }) =>
      edit((t) => ({
        ...t,
        rows: t.rows.filter((r) => r.id !== id),
        total: t.total - 1,
      })),
    onError: reload,
  });
};

/** Wraps a bulk mutation so every record query reloads once it settles. */
const useBulkRecordMutation = <TInput, TResult>(
  companyId: string,
  table: string,
  useInner: (
    companyId: string,
    table: string,
  ) => {
    mutateAsync: (input: TInput) => Promise<TResult>;
  },
) => {
  const queryClient = useQueryClient();
  const inner = useInner(companyId, table);
  return useMutation({
    mutationFn: (input: TInput) => inner.mutateAsync(input),
    onSettled: () => {
      forgetLatestRecords(queryClient, companyId);
      return queryClient.invalidateQueries({ queryKey: ['record'] });
    },
  });
};

/** Appends rows from a CSV; a `400` carries per-row `errors` (see {@link recordErrorBody}). */
export const useAppendRecordsCsv = (companyId: string, table: string) =>
  useBulkRecordMutation(companyId, table, useAppendRecordsCsvMutation);

/** Removes every row, keeping the table. */
export const useClearRecordTable = (companyId: string, table: string) =>
  useBulkRecordMutation(companyId, table, useClearRecordTableMutation);

/**
 * The drop request, which then forgets the dropped table's own queries.
 * Without that, the reload every bulk change does would wait for the gone
 * table to be fetched again: a 404 that TanStack retries with back-off, so
 * the delete seemed to take several seconds to finish, and whatever ran after
 * it (going back to the menu) ran that much later.
 */
const useDropAndForget = (companyId: string, table: string) => {
  const queryClient = useQueryClient();
  const drop = useDropRecordTableMutation(companyId, table);
  return {
    mutateAsync: async () => {
      const result = await drop.mutateAsync();
      queryClient.removeQueries({
        queryKey: queryKeys.recordTable(companyId, table),
      });
      queryClient.removeQueries({
        queryKey: queryKeys.recordTableLatest(companyId, table),
      });
      return result;
    },
  };
};

/** Removes the table and its rows. */
export const useDropRecordTable = (companyId: string, table: string) =>
  useBulkRecordMutation(companyId, table, useDropAndForget);

// Column changes rewrite every row, so each reloads every record view (001.06).

/** Adds a column; a `409` `do_not_store` means its default needs confirming. */
export const useAddColumn = (companyId: string, table: string) =>
  useBulkRecordMutation(companyId, table, useAddColumnMutation);

/** Renames a column. */
export const useRenameColumn = (companyId: string, table: string) =>
  useBulkRecordMutation(companyId, table, useRenameColumnMutation);

/** Deletes a column and its values. */
export const useDeleteColumn = (companyId: string, table: string) =>
  useBulkRecordMutation(companyId, table, useDeleteColumnMutation);

/** Replaces the primary key; a `400` or `409` says which rows stop it. */
export const useSetPrimaryKey = (companyId: string, table: string) =>
  useBulkRecordMutation(companyId, table, useSetPrimaryKeyMutation);

/** Adds a unique key; a `400` or `409` says which rows stop it. */
export const useAddUniqueKey = (companyId: string, table: string) =>
  useBulkRecordMutation(companyId, table, useAddUniqueKeyMutation);

/** Drops a unique key. */
export const useDropUniqueKey = (companyId: string, table: string) =>
  useBulkRecordMutation(companyId, table, useDropUniqueKeyMutation);

/** Changes a column's type; a `409` `unconvertible` asks whether to blank what won't convert. */
export const useRetypeColumn = (companyId: string, table: string) =>
  useBulkRecordMutation(companyId, table, useRetypeColumnMutation);

/**
 * Deletes chosen rows together, removing them from the cached table where
 * they stand; the rest don't move (ADR-027). Searches and counts reload.
 */
export const useDeleteRecords = (companyId: string, table: string) => {
  const queryClient = useQueryClient();
  const { edit, reload } = useRecordCache(companyId, table);
  const remove = useDeleteRecordsMutation(companyId, table);
  return useMutation({
    mutationFn: (rows: { id: string; version: number }[]) =>
      remove.mutateAsync(rows),
    onSuccess: ({ removed }, rows) => {
      const gone = new Set(rows.map((r) => r.id));
      edit((t) => ({
        ...t,
        rows: t.rows.filter((r) => !gone.has(r.id)),
        total: t.total - removed,
      }));
      forgetLatestRecords(queryClient, companyId, latestSearches);
      void queryClient.invalidateQueries({
        queryKey: ['record', 'search'],
      });
    },
    onError: reload,
  });
};

/**
 * Deletes chosen rows from several tables, as from a search's results.
 * Every record query reloads afterwards, whatever happened.
 */
export const useDeleteRecordsAcross = (companyId: string) => {
  const queryClient = useQueryClient();
  const remove = useDeleteRecordsAcrossMutation(companyId);
  return useMutation({
    mutationFn: (
      byTable: Readonly<
        Record<string, readonly { id: string; version: number }[]>
      >,
    ) => remove.mutateAsync(byTable),
    onSettled: () => {
      forgetLatestRecords(queryClient, companyId);
      return queryClient.invalidateQueries({ queryKey: ['record'] });
    },
  });
};

/** Sets or clears a table's retention, updating its cached definition. */
export const useSetRetention = (companyId: string, table: string) => {
  const queryClient = useQueryClient();
  const set = useSetRetentionMutation(companyId, table);
  return useMutation({
    mutationFn: (retention: RecordTableRetention | null) =>
      set.mutateAsync(retention),
    onSuccess: (definition: RecordTableDefinition) => {
      queryClient.setQueryData<RecordTableRows>(
        queryKeys.recordTable(companyId, table),
        (current) =>
          current === undefined ? current : { ...current, definition },
      );
    },
  });
};

/**
 * How what is on screen differs from what is stored now (001.05). Nothing,
 * until a change elsewhere is heard and a fresher copy has been read.
 */
export interface LiveRecordChanges extends TableChanges {
  /** The table itself was deleted elsewhere. */
  readonly dropped: boolean;
  /** Anything at all differs: the sheet is out of date. */
  readonly any: boolean;
}

/** One table's differences: its rows, and whether its columns or key changed (001.06). */
export interface TableChanges extends RowChanges {
  /**
   * The table's columns or key were changed elsewhere. Every edit made
   * against the columns on screen could go to the wrong place, so the whole
   * sheet waits for a reload.
   */
  readonly columnsChanged: boolean;
}

/** What a sheet with nothing changed elsewhere shows. */
const UNCHANGED: LiveRecordChanges = {
  ...NO_ROW_CHANGES,
  columnsChanged: false,
  dropped: false,
  any: false,
};

/** Adds `dropped` and `any` to a comparison. */
const withSummary = (changes: TableChanges): LiveRecordChanges => ({
  ...changes,
  dropped: false,
  any:
    changes.columnsChanged ||
    changes.changed.size + changes.deleted.size + changes.added > 0,
});

/**
 * Compares an open table's rows with the copy read when it last changed
 * elsewhere. Live, but it never fetches: the company stream does that
 * (`recordChanged`), and only for tables someone has open.
 */
export const useLiveRecordTableChanges = (
  companyId: string,
  table: string,
  shown: RecordTableRows | undefined,
): LiveRecordChanges => {
  const latest = useQuery<LatestRecordTable>({
    queryKey: queryKeys.recordTableLatest(companyId, table),
    queryFn: skipToken,
  });
  return useMemo(() => {
    if (latest.data === undefined || shown === undefined) return UNCHANGED;
    if (latest.data === null) return { ...UNCHANGED, dropped: true, any: true };
    return withSummary({
      ...compareRows(shown.rows, latest.data.rows, latest.data.truncated),
      columnsChanged: !sameColumns(shown.definition, latest.data.definition),
    });
  }, [latest.data, shown]);
};

/** A search's differences: per table shown, and for the search as a whole. */
export interface LiveRecordSearchChanges extends LiveRecordChanges {
  /** Each shown table's differences, by table name. */
  readonly byTable: ReadonlyMap<string, TableChanges>;
}

/**
 * {@link useLiveRecordTableChanges} for a search: rows that now match but
 * weren't shown, including whole tables, count as added; rows that no longer
 * match count as deleted, since either way they are no longer in the results.
 */
export const useLiveRecordSearchChanges = (
  companyId: string,
  q: string,
  shown: RecordSearchResult | undefined,
): LiveRecordSearchChanges => {
  const latest = useQuery<RecordSearchResult>({
    queryKey: queryKeys.recordSearchLatest(companyId, q),
    queryFn: skipToken,
  });
  return useMemo(() => {
    if (latest.data === undefined || shown === undefined) {
      return { ...UNCHANGED, byTable: new Map() };
    }
    const fresh = new Map(
      latest.data.groups.map((g) => [g.definition.name, g]),
    );
    const byTable = new Map<string, TableChanges>();
    const changed = new Set<string>();
    const deleted = new Set<string>();
    let added = 0;
    let columnsChanged = false;
    for (const group of shown.groups) {
      const name = group.definition.name;
      const now = fresh.get(name);
      const changes = {
        ...compareRows(group.rows, now?.rows ?? [], latest.data.truncated),
        // A table with no matches left says nothing about its columns.
        columnsChanged:
          now !== undefined && !sameColumns(group.definition, now.definition),
      };
      byTable.set(name, changes);
      columnsChanged ||= changes.columnsChanged;
      changes.changed.forEach((id) => changed.add(id));
      changes.deleted.forEach((id) => deleted.add(id));
      added += changes.added;
      fresh.delete(name);
    }
    // Tables that weren't in the results at all, and now are.
    for (const group of fresh.values()) added += group.rows.length;
    return {
      ...withSummary({ changed, deleted, added, columnsChanged }),
      byTable,
    };
  }, [latest.data, shown]);
};

/** Wraps a do-not-store mutation so the list reloads once it settles. */
const useDoNotStoreMutation = <TInput, TResult>(
  companyId: string,
  useInner: (companyId: string) => {
    mutateAsync: (input: TInput) => Promise<TResult>;
  },
) => {
  const queryClient = useQueryClient();
  const inner = useInner(companyId);
  return useMutation({
    mutationFn: (input: TInput) => inner.mutateAsync(input),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.doNotStore(companyId),
      }),
  });
};

/** Adds an entry to the do-not-store list; a `409` means it is already there. */
export const useAddDoNotStore = (companyId: string) =>
  useDoNotStoreMutation(companyId, useAddDoNotStoreMutation);

/** Changes a do-not-store entry's text or note. */
export const useUpdateDoNotStore = (companyId: string) =>
  useDoNotStoreMutation(companyId, useUpdateDoNotStoreMutation);

/** Removes a do-not-store entry. */
export const useRemoveDoNotStore = (companyId: string) =>
  useDoNotStoreMutation(companyId, useRemoveDoNotStoreMutation);

/** Saves a blob under a name: a temporary object URL and a clicked anchor. */
const saveBlob = (blob: Blob, name: string): void => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
};

/** Downloads one table as CSV, named in local time by the browser, not the server. */
export const downloadRecordTableCsv = async (
  companyId: string,
  companySlug: string,
  table: string,
): Promise<void> => {
  const { blob } = await getBlob(recordTableCsvPath(companyId, table));
  saveBlob(blob, recordsDownloadName(companySlug, table, 'csv'));
};

/** Downloads every table as one zip. */
export const downloadAllRecordTables = async (
  companyId: string,
  companySlug: string,
): Promise<void> => {
  const { blob } = await getBlob(recordsExportPath(companyId));
  saveBlob(blob, recordsDownloadName(companySlug, 'tables', 'zip'));
};

/**
 * Downloads chosen rows: per table, the ids picked or `all`. One table comes
 * as a CSV, several as a zip of CSVs.
 */
export const downloadRecordSelection = async (
  companyId: string,
  companySlug: string,
  tables: Readonly<Record<string, readonly string[] | 'all'>>,
): Promise<void> => {
  const names = Object.keys(tables);
  const { blob } = await postJsonForBlob(
    recordsSelectionExportPath(companyId),
    {
      tables,
    },
  );
  saveBlob(
    blob,
    names.length === 1
      ? recordsDownloadName(companySlug, names[0], 'csv')
      : recordsDownloadName(companySlug, 'tables', 'zip'),
  );
};
