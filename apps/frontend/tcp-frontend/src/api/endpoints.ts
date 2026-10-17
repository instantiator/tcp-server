import {
  useMutation,
  useQuery,
  type UseQueryOptions,
} from '@tanstack/react-query';

import {
  api,
  expectAccepted,
  getBlob,
  postFile,
  postFileForJson,
  postJsonForBlob,
  unwrap,
} from './client';
import { apiError, networkError } from './errors';
import {
  queryKeys,
  type AgentListParams,
  type AssignmentListParams,
  type CompanyListParams,
  type ConversationListParams,
  type TaskListParams,
} from './query-keys';
import type {
  AddColumn,
  AppendRecordsCsvResult,
  RetypeColumn,
  RecordTableRetention,
} from './dtos';
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
 * The ids of the company's agents whose transcripts contain `q`. Waits for two
 * characters, which is the shortest search the server accepts.
 */
export const useTranscriptSearch = (companyId: string, q: string) =>
  useQuery({
    queryKey: queryKeys.agentSearch(companyId, q),
    queryFn: async () =>
      (
        await unwrap(
          api.GET('/api/agent/search', { params: { query: { companyId, q } } }),
        )
      ).agentIds,
    enabled: q.trim().length >= 2,
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

/** Whose knowledge: one role's, or the company's shared. */
export type KnowledgeScope =
  | { readonly kind: 'role'; readonly roleId: string }
  | { readonly kind: 'company'; readonly companyId: string };

/** The knowledge route for a scope; only the upload path needs it, as it cannot go through `api`. */
const knowledgeBase = (scope: KnowledgeScope): string =>
  scope.kind === 'role'
    ? `/api/role/${encodeURIComponent(scope.roleId)}/knowledge`
    : `/api/company/${encodeURIComponent(scope.companyId)}/knowledge`;

type Schemas = components['schemas'];

/** What a knowledge read takes beyond its ids: a wrapper's polling and gating. */
type KnowledgeReadOptions<T> = Pick<
  UseQueryOptions<T>,
  'refetchInterval' | 'enabled'
>;

export const useRoleKnowledge = (
  roleId: string,
  options: KnowledgeReadOptions<Schemas['KnowledgeDocumentResponseDto'][]> = {},
) =>
  useQuery({
    ...options,
    queryKey: queryKeys.roleKnowledge(roleId),
    queryFn: () =>
      unwrap(
        api.GET('/api/role/{roleId}/knowledge', {
          params: { path: { roleId } },
        }),
      ),
  });

export const useRoleKnowledgeStatus = (
  roleId: string,
  options: KnowledgeReadOptions<Schemas['KnowledgeStatusResponseDto']> = {},
) =>
  useQuery({
    ...options,
    queryKey: queryKeys.roleKnowledgeStatus(roleId),
    queryFn: () =>
      unwrap(
        api.GET('/api/role/{roleId}/knowledge/status', {
          params: { path: { roleId } },
        }),
      ),
  });

export const useRoleKnowledgeSearch = (
  roleId: string,
  query: string,
  options: KnowledgeReadOptions<Schemas['KnowledgeChunkResponseDto'][]> = {},
) =>
  useQuery({
    ...options,
    queryKey: queryKeys.roleKnowledgeSearch(roleId, query),
    queryFn: () =>
      unwrap(
        api.GET('/api/role/{roleId}/knowledge/query', {
          params: { path: { roleId }, query: { q: query } },
        }),
      ),
  });

export const useCompanyKnowledge = (
  companyId: string,
  options: KnowledgeReadOptions<Schemas['KnowledgeDocumentResponseDto'][]> = {},
) =>
  useQuery({
    ...options,
    queryKey: queryKeys.companyKnowledge(companyId),
    queryFn: () =>
      unwrap(
        api.GET('/api/company/{companyId}/knowledge', {
          params: { path: { companyId } },
        }),
      ),
  });

/**
 * The company's shared index and each role's. Generic in what `select` picks,
 * so a wrapper can read one part while `refetchInterval` still sees the whole.
 */
export const useCompanyKnowledgeStatus = <
  TData = Schemas['CompanyKnowledgeStatusResponseDto'],
>(
  companyId: string,
  options: Pick<
    UseQueryOptions<Schemas['CompanyKnowledgeStatusResponseDto'], Error, TData>,
    'refetchInterval' | 'enabled' | 'select'
  > = {},
) =>
  useQuery({
    ...options,
    queryKey: queryKeys.companyKnowledgeStatus(companyId),
    queryFn: () =>
      unwrap(
        api.GET('/api/company/{companyId}/knowledge/status', {
          params: { path: { companyId } },
        }),
      ),
  });

export const useCompanyKnowledgeSearch = (
  companyId: string,
  query: string,
  options: KnowledgeReadOptions<Schemas['KnowledgeChunkResponseDto'][]> = {},
) =>
  useQuery({
    ...options,
    queryKey: queryKeys.companyKnowledgeSearch(companyId, query),
    queryFn: () =>
      unwrap(
        api.GET('/api/company/{companyId}/knowledge/query', {
          params: { path: { companyId }, query: { q: query } },
        }),
      ),
  });

/** The MCP servers a role can be given, and which this deployment has configured. */
export const useMcpServers = () =>
  useQuery({
    queryKey: queryKeys.mcpServers(),
    queryFn: () => unwrap(api.GET('/api/mcp-servers')),
  });

/** The app's default models (env config), for the picker's fallback labels. */
export const useLlmDefaults = () =>
  useQuery({
    queryKey: queryKeys.llmDefaults(),
    queryFn: () => unwrap(api.GET('/api/system/llm-defaults')),
  });

/** What a local or custom model server offers. */
export type LocalModelsQuery = Schemas['ListLlmModelsDto'];

/**
 * The models a local or custom server lists, fetched through tcp-server (the
 * browser can't reach `host.docker.internal`, and the saved key stays there).
 * A POST, so a typed key travels in the body. Disabled for `null`, and not
 * retried: a server that isn't running won't be on the next try either. Bump
 * `revision` to ask again.
 */
export const useLocalModelsQuery = (
  companyId: string,
  query: LocalModelsQuery | null,
  revision = 0,
) =>
  useQuery({
    queryKey: queryKeys.localModels(
      companyId,
      query?.provider ?? '',
      query?.baseUrl ?? '',
      query?.roleId,
      revision,
    ),
    queryFn: () =>
      unwrap(
        api.POST('/api/company/{companyId}/llm/models', {
          params: { path: { companyId } },
          // `query` is non-null whenever the query is enabled.
          body: query ?? { provider: '', baseUrl: '' },
        }),
      ),
    enabled: query !== null,
    retry: false,
  });

/** What a role's tool schemas cost per turn in `mode`. */
export const useToolFootprintQuery = (
  companyId: string,
  slug: string | undefined,
  mode: 'implement' | 'plan' | 'qa' | 'chat' | 'consultee' | 'finalise',
) =>
  useQuery({
    queryKey: queryKeys.toolFootprint(companyId, slug ?? '', mode),
    queryFn: () =>
      unwrap(
        api.GET(
          '/api/company/{companyId}/roles/by-slug/{slug}/tool-footprint',
          {
            params: { path: { companyId, slug: slug ?? '' }, query: { mode } },
          },
        ),
      ),
    enabled: slug !== undefined,
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
 * Deletes a chat with its agent and transcript. `expectAccepted`, not
 * `unwrap` — the route answers `204`, with no body.
 */
export const useDeleteChatMutation = (id: string) =>
  useMutation({
    mutationFn: () =>
      expectAccepted(
        api.DELETE('/api/agent/{id}/chat', { params: { path: { id } } }),
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
 * Closes a finished task's room in the office view. The server refuses (409)
 * a task that hasn't finished; closing twice is a no-op.
 */
export const useCloseTaskVisualisationMutation = (id: string) =>
  useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/task/{id}/close-visualisation', {
          params: { path: { id } },
        }),
      ),
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
 * Uploads one file to a role's or the company's knowledge. The `signal` lets
 * the caller cancel it.
 *
 * Goes through {@link postFile} rather than {@link api} for the same reason as
 * {@link useUploadMaterialMutation}: a `File` cannot travel through the
 * generated body type.
 */
export const useUploadKnowledgeMutation = (scope: KnowledgeScope) =>
  useMutation({
    mutationFn: ({ file, signal }: { file: File; signal?: AbortSignal }) =>
      postFile(knowledgeBase(scope), file, signal),
  });

/**
 * Deletes one knowledge file, with the role's or the company's route per scope.
 * `expectAccepted`, not `unwrap`: the route answers 204 with no body.
 */
export const useDeleteKnowledgeMutation = (scope: KnowledgeScope) =>
  useMutation({
    mutationFn: (filename: string) =>
      scope.kind === 'role'
        ? expectAccepted(
            api.DELETE('/api/role/{roleId}/knowledge/{filename}', {
              params: { path: { roleId: scope.roleId, filename } },
            }),
          )
        : expectAccepted(
            api.DELETE('/api/company/{companyId}/knowledge/{filename}', {
              params: { path: { companyId: scope.companyId, filename } },
            }),
          ),
  });

/**
 * Rebuilds a knowledge index. `unwrap`, not `expectAccepted`: the route
 * answers `202` but with `{ reindexing: true }` as its body.
 */
export const useReindexKnowledgeMutation = (scope: KnowledgeScope) =>
  useMutation({
    mutationFn: () =>
      scope.kind === 'role'
        ? unwrap(
            api.POST('/api/role/{roleId}/knowledge/reindex', {
              params: { path: { roleId: scope.roleId } },
            }),
          )
        : unwrap(
            api.POST('/api/company/{companyId}/knowledge/reindex', {
              params: { path: { companyId: scope.companyId } },
            }),
          ),
  });

/** Creates a role. Soft warnings come back beside it, as for {@link useCreateTaskMutation}. */
export const useCreateRoleMutation = () =>
  useMutation({
    mutationFn: async (body: Schemas['CreateRoleDto']) => {
      let result;
      try {
        result = await api.POST('/api/role', { body });
      } catch (cause) {
        // The request never landed — same reasoning as `unwrap`'s catch.
        throw networkError(cause);
      }

      const { data, error, response } = result;
      if (!response.ok || data === undefined) throw apiError(response, error);

      return { role: data, warnings: readWarnings(response) };
    },
  });

/** Edits a role. Soft warnings come back beside it, as for {@link useCreateRoleMutation}. */
export const useUpdateRoleMutation = () =>
  useMutation({
    mutationFn: async ({
      id,
      body,
    }: {
      id: string;
      body: Schemas['UpdateRoleDto'];
    }) => {
      let result;
      try {
        result = await api.PUT('/api/role/{id}', {
          params: { path: { id } },
          body,
        });
      } catch (cause) {
        // The request never landed — same reasoning as `unwrap`'s catch.
        throw networkError(cause);
      }

      const { data, error, response } = result;
      if (!response.ok || data === undefined) throw apiError(response, error);

      return { role: data, warnings: readWarnings(response) };
    },
  });

/**
 * Creates a company. Never asks to replace: an existing slug comes back as a
 * 409 {@link ApiError}, so a form can say the slug is taken.
 */
export const useCreateCompanyMutation = () =>
  useMutation({
    mutationFn: async (body: Schemas['CreateCompanyDto']) => {
      let result;
      try {
        result = await api.POST('/api/company', { body });
      } catch (cause) {
        // The request never landed — same reasoning as `unwrap`'s catch.
        throw networkError(cause);
      }

      const { data, error, response } = result;
      if (!response.ok || data === undefined) throw apiError(response, error);

      return { company: data, warnings: readWarnings(response) };
    },
  });

/** Edits a company. Soft warnings come back beside it, as for a role. */
export const useUpdateCompanyMutation = () =>
  useMutation({
    mutationFn: async ({
      id,
      body,
    }: {
      id: string;
      body: Schemas['UpdateCompanyDto'];
    }) => {
      let result;
      try {
        result = await api.PUT('/api/company/{id}', {
          params: { path: { id } },
          body,
        });
      } catch (cause) {
        // The request never landed — same reasoning as `unwrap`'s catch.
        throw networkError(cause);
      }

      const { data, error, response } = result;
      if (!response.ok || data === undefined) throw apiError(response, error);

      return { company: data, warnings: readWarnings(response) };
    },
  });

/**
 * Deletes a company and everything it owns. `expectAccepted`, not `unwrap`:
 * the route answers 204 with no body.
 */
export const useDeleteCompanyMutation = () =>
  useMutation({
    mutationFn: (id: string) =>
      expectAccepted(
        api.DELETE('/api/company/{id}', { params: { path: { id } } }),
      ),
  });

/**
 * Deletes a role, and its knowledge files with it. `expectAccepted`, not
 * `unwrap`: the route answers 204 with no body.
 */
export const useDeleteRoleMutation = () =>
  useMutation({
    mutationFn: (id: string) =>
      expectAccepted(
        api.DELETE('/api/role/{id}', { params: { path: { id } } }),
      ),
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

/**
 * Who the caller is to the system and whether a shutdown is under way. Takes
 * the cache and polling options its wrapper in `hooks.ts` chooses; none is
 * set here (see the header).
 */
export const useSystemStatusQuery = (
  options: Pick<
    UseQueryOptions<components['schemas']['SystemStatusResponseDto']>,
    'staleTime' | 'retry' | 'refetchInterval' | 'enabled'
  > = {},
) =>
  useQuery({
    ...options,
    queryKey: queryKeys.systemStatus(),
    queryFn: () => unwrap(api.GET('/api/system/status')),
  });

/**
 * The shutdown state, for the dialog that controls it. The wrapper in
 * `hooks.ts` chooses the polling; none is set here.
 */
export const useShutdownStatusQuery = (
  options: Pick<
    UseQueryOptions<components['schemas']['ShutdownStatusResponseDto']>,
    'retry' | 'refetchInterval' | 'enabled'
  > = {},
) =>
  useQuery({
    ...options,
    queryKey: queryKeys.shutdownStatus(),
    queryFn: () => unwrap(api.GET('/api/system/shutdown')),
  });

/**
 * Starts draining. A bare `?force=` or `?restart=` is how the server reads a
 * flag: present and not `'false'`.
 */
export const useBeginShutdownMutation = () =>
  useMutation({
    mutationFn: ({ force, restart }: { force: boolean; restart: boolean }) =>
      unwrap(
        api.POST('/api/system/shutdown', {
          params: {
            query: {
              ...(force && { force: '' }),
              ...(restart && { restart: '' }),
            },
          },
        }),
      ),
  });

/** Cancels the drain and reopens intake. */
export const useCancelShutdownMutation = () =>
  useMutation({
    mutationFn: () => unwrap(api.DELETE('/api/system/shutdown')),
  });

/** The health of every service the system depends on. Administrators only. */
export const useSystemHealthQuery = () =>
  useQuery({
    queryKey: queryKeys.systemHealth(),
    queryFn: () => unwrap(api.GET('/api/system/health')),
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

/** A company's active notifications plus the application-wide ones, newest first. */
export const useNotifications = (companyId: string) =>
  useQuery({
    queryKey: queryKeys.notifications(companyId),
    queryFn: () =>
      unwrap(
        api.GET('/api/notifications/company/{companyId}', {
          params: { path: { companyId } },
        }),
      ),
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

// Company record tables. The company stream says when a table changes
// (001.05): the summaries then refetch, but an open table or search never
// does by itself — it is compared with a fresher copy instead (ADR-027).

const recordsBase = (companyId: string) =>
  `/api/company/${encodeURIComponent(companyId)}/records`;

export const useRecordTables = (companyId: string) =>
  useQuery({
    queryKey: queryKeys.recordTables(companyId),
    queryFn: () =>
      unwrap(
        api.GET('/api/company/{companyId}/records/tables', {
          params: { path: { companyId } },
        }),
      ),
  });

/** Reads one table's definition and rows. */
export const fetchRecordTable = (companyId: string, table: string) =>
  unwrap(
    api.GET('/api/company/{companyId}/records/tables/{table}', {
      params: { path: { companyId, table } },
    }),
  );

/** One table's definition and rows; idle while `table` is `null` (none chosen). */
export const useRecordTable = (companyId: string, table: string | null) =>
  useQuery({
    queryKey: queryKeys.recordTable(companyId, table ?? ''),
    enabled: table !== null,
    // A focus refetch re-sorts the rows under a user who is mid-read (ADR-027).
    refetchOnWindowFocus: false,
    queryFn: () => fetchRecordTable(companyId, table ?? ''),
  });

/**
 * What a person confirmed when warned that data matches the do-not-store
 * list. Without it, such data is a `409` with code `do_not_store`.
 */
export interface DoNotStoreConfirmation {
  readonly confirmDoNotStore?: boolean;
}

/** Adds one row. A duplicate unique key is a `409` carrying the existing `recordId`. */
export const useAddRecordMutation = (companyId: string, table: string) =>
  useMutation({
    mutationFn: (
      input: { data: Record<string, unknown> } & DoNotStoreConfirmation,
    ) =>
      unwrap(
        api.POST('/api/company/{companyId}/records/tables/{table}/rows', {
          params: {
            path: { companyId, table },
            // Sent only when confirmed, so an ordinary save's URL is unchanged.
            query:
              input.confirmDoNotStore === true
                ? { confirmDoNotStore: true }
                : undefined,
          },
          body: { data: input.data },
        }),
      ),
  });

/** Changes a row; `version` is the one the user read, and a `409` means it moved. */
export const useUpdateRecordMutation = (companyId: string, table: string) =>
  useMutation({
    mutationFn: (
      input: {
        id: string;
        changes: Record<string, unknown>;
        version: number;
      } & DoNotStoreConfirmation,
    ) =>
      unwrap(
        api.PATCH('/api/company/{companyId}/records/tables/{table}/rows/{id}', {
          params: {
            path: { companyId, table, id: input.id },
            // Sent only when confirmed, so an ordinary save's URL is unchanged.
            query:
              input.confirmDoNotStore === true
                ? { confirmDoNotStore: true }
                : undefined,
          },
          body: { changes: input.changes, version: input.version },
        }),
      ),
  });

/** Deletes a row at the version the user read; answers `204`. */
export const useDeleteRecordMutation = (companyId: string, table: string) =>
  useMutation({
    mutationFn: (input: { id: string; version: number }) =>
      expectAccepted(
        api.DELETE(
          '/api/company/{companyId}/records/tables/{table}/rows/{id}',
          {
            params: {
              path: { companyId, table, id: input.id },
              query: { version: input.version },
            },
          },
        ),
      ),
  });

/** Appends a CSV's rows; a `400` body lists the bad rows in `errors`. */
export const useAppendRecordsCsvMutation = (companyId: string, table: string) =>
  useMutation({
    mutationFn: async (
      input: { file: File } & DoNotStoreConfirmation,
    ): Promise<AppendRecordsCsvResult> => {
      const result = await postFileForJson(
        recordTableCsvPath(companyId, table) +
          (input.confirmDoNotStore === true ? '?confirmDoNotStore=true' : ''),
        input.file,
      );
      if (
        typeof result === 'object' &&
        result !== null &&
        'inserted' in result &&
        typeof result.inserted === 'number' &&
        'alreadyExists' in result &&
        typeof result.alreadyExists === 'number'
      ) {
        return {
          inserted: result.inserted,
          alreadyExists: result.alreadyExists,
        };
      }
      throw networkError(new Error('Unexpected CSV upload response'));
    },
  });

/** Removes every row but keeps the table. */
export const useClearRecordTableMutation = (companyId: string, table: string) =>
  useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE('/api/company/{companyId}/records/tables/{table}/rows', {
          params: { path: { companyId, table } },
        }),
      ),
  });

/** Removes the table and its rows. */
export const useDropRecordTableMutation = (companyId: string, table: string) =>
  useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE('/api/company/{companyId}/records/tables/{table}', {
          params: { path: { companyId, table } },
        }),
      ),
  });

/** Deletes chosen rows together; a `409` means one moved on, and none went. */
export const useDeleteRecordsMutation = (companyId: string, table: string) =>
  useMutation({
    mutationFn: (rows: { id: string; version: number }[]) =>
      unwrap(
        api.POST(
          '/api/company/{companyId}/records/tables/{table}/rows/delete',
          { params: { path: { companyId, table } }, body: { rows } },
        ),
      ),
  });

/**
 * Deletes chosen rows from several tables: each table's rows all or none.
 * Returns how many went in all.
 */
// ponytail: one request per table, so a failure part-way leaves the earlier
// tables' deletions done. Add a cross-table route if that ever matters.
export const useDeleteRecordsAcrossMutation = (companyId: string) =>
  useMutation({
    mutationFn: async (
      byTable: Readonly<
        Record<string, readonly { id: string; version: number }[]>
      >,
    ) => {
      let removed = 0;
      for (const [table, rows] of Object.entries(byTable)) {
        const result = await unwrap(
          api.POST(
            '/api/company/{companyId}/records/tables/{table}/rows/delete',
            {
              params: { path: { companyId, table } },
              body: { rows: [...rows] },
            },
          ),
        );
        removed += result.removed;
      }
      return { removed };
    },
  });

/** Sets how long a table keeps its rows, or `null` to keep them until deleted. */
export const useSetRetentionMutation = (companyId: string, table: string) =>
  useMutation({
    mutationFn: (retention: RecordTableRetention | null) =>
      unwrap(
        api.PUT('/api/company/{companyId}/records/tables/{table}/retention', {
          params: { path: { companyId, table } },
          body: { retention },
        }),
      ),
  });

/** Adds a column; every existing row gets `default`, when one is given (001.06). */
export const useAddColumnMutation = (companyId: string, table: string) =>
  useMutation({
    mutationFn: ({
      confirmDoNotStore,
      ...column
    }: AddColumn & DoNotStoreConfirmation) =>
      unwrap(
        api.POST('/api/company/{companyId}/records/tables/{table}/columns', {
          params: {
            path: { companyId, table },
            query:
              confirmDoNotStore === true ? { confirmDoNotStore } : undefined,
          },
          body: column,
        }),
      ),
  });

/** Renames a column in the table and every row. */
export const useRenameColumnMutation = (companyId: string, table: string) =>
  useMutation({
    mutationFn: ({ column, newName }: { column: string; newName: string }) =>
      unwrap(
        api.PATCH(
          '/api/company/{companyId}/records/tables/{table}/columns/{column}',
          { params: { path: { companyId, table, column } }, body: { newName } },
        ),
      ),
  });

/** Deletes a column and its value from every row; a key column is refused. */
export const useDeleteColumnMutation = (companyId: string, table: string) =>
  useMutation({
    mutationFn: (column: string) =>
      unwrap(
        api.DELETE(
          '/api/company/{companyId}/records/tables/{table}/columns/{column}',
          { params: { path: { companyId, table, column } } },
        ),
      ),
  });

/** Replaces the table's primary key; refused when rows would share a key or lack a value. */
export const useSetPrimaryKeyMutation = (companyId: string, table: string) =>
  useMutation({
    mutationFn: (fields: string[]) =>
      unwrap(
        api.PUT('/api/company/{companyId}/records/tables/{table}/primary-key', {
          params: { path: { companyId, table } },
          body: { fields },
        }),
      ),
  });

/** Adds a unique key over `fields`; refused when rows lack a value or would clash. */
export const useAddUniqueKeyMutation = (companyId: string, table: string) =>
  useMutation({
    mutationFn: (fields: string[]) =>
      unwrap(
        api.POST(
          '/api/company/{companyId}/records/tables/{table}/unique-keys',
          {
            params: { path: { companyId, table } },
            body: { fields },
          },
        ),
      ),
  });

/** Drops the unique key over exactly `fields`. */
export const useDropUniqueKeyMutation = (companyId: string, table: string) =>
  useMutation({
    mutationFn: (fields: readonly string[]) =>
      unwrap(
        api.DELETE(
          '/api/company/{companyId}/records/tables/{table}/unique-keys/{key}',
          { params: { path: { companyId, table, key: fields.join(',') } } },
        ),
      ),
  });

/**
 * Changes a column's type; a `409` `unconvertible` names the values that
 * won't convert, and `blankUnconvertible` confirms blanking them.
 */
export const useRetypeColumnMutation = (companyId: string, table: string) =>
  useMutation({
    mutationFn: ({
      column,
      blankUnconvertible,
      ...type
    }: RetypeColumn & { column: string; blankUnconvertible?: boolean }) =>
      unwrap(
        api.PUT(
          '/api/company/{companyId}/records/tables/{table}/columns/{column}/type',
          {
            params: {
              path: { companyId, table, column },
              query:
                blankUnconvertible === true
                  ? { blankUnconvertible }
                  : undefined,
            },
            body: type,
          },
        ),
      ),
  });

/**
 * Rows in any table with a field containing `q`, grouped by table; idle
 * while `q` is empty. A POST under the hood, so the name searched for stays
 * out of URLs, but a query here: it is read, cached and refreshed like one.
 */
export const useRecordSearch = (companyId: string, q: string) =>
  useQuery({
    queryKey: queryKeys.recordSearch(companyId, q),
    enabled: q !== '',
    // Like a table: a focus refetch would move rows under a reader.
    refetchOnWindowFocus: false,
    queryFn: () => fetchRecordSearch(companyId, q),
  });

/** Runs a search across every table: see {@link useRecordSearch}. */
export const fetchRecordSearch = (companyId: string, q: string) =>
  unwrap(
    api.POST('/api/company/{companyId}/records/search', {
      params: { path: { companyId } },
      body: { q },
    }),
  );

/** The company's do-not-store list. */
export const useDoNotStoreList = (companyId: string) =>
  useQuery({
    queryKey: queryKeys.doNotStore(companyId),
    queryFn: () =>
      unwrap(
        api.GET('/api/company/{companyId}/records/do-not-store', {
          params: { path: { companyId } },
        }),
      ),
  });

/** Adds an entry; a `409` means it is already on the list. */
export const useAddDoNotStoreMutation = (companyId: string) =>
  useMutation({
    mutationFn: (entry: { value: string; note?: string }) =>
      unwrap(
        api.POST('/api/company/{companyId}/records/do-not-store', {
          params: { path: { companyId } },
          body: entry,
        }),
      ),
  });

/** Changes an entry's text or note; `note: null` clears it. */
export const useUpdateDoNotStoreMutation = (companyId: string) =>
  useMutation({
    mutationFn: (input: { id: string; value?: string; note?: string | null }) =>
      unwrap(
        api.PATCH('/api/company/{companyId}/records/do-not-store/{id}', {
          params: { path: { companyId, id: input.id } },
          body: { value: input.value, note: input.note },
        }),
      ),
  });

/** Removes an entry; answers `204`. */
export const useRemoveDoNotStoreMutation = (companyId: string) =>
  useMutation({
    mutationFn: (id: string) =>
      expectAccepted(
        api.DELETE('/api/company/{companyId}/records/do-not-store/{id}', {
          params: { path: { companyId, id } },
        }),
      ),
  });

/** The route a selection export is posted to. */
export const recordsSelectionExportPath = (companyId: string) =>
  `${recordsBase(companyId)}/export`;

/** The route a table's CSV download is served from. */
export const recordTableCsvPath = (companyId: string, table: string) =>
  `${recordsBase(companyId)}/tables/${encodeURIComponent(table)}/csv`;

/** The route the all-tables zip download is served from. */
export const recordsExportPath = (companyId: string) =>
  `${recordsBase(companyId)}/export`;

export { getBlob, postJsonForBlob };
