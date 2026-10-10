/**
 * Every query key in the application, built in one place.
 *
 * ## The convention
 *
 * A key is `[entity, scope, ...discriminators]`.
 *
 * **`entity` is the string tcp-server puts in an event's `payload.entity`, not
 * the name of the route the data came from.** That is the whole point: live
 * events invalidate by key (ADR-025), so `invalidateQueries({ queryKey: [entity] })`
 * reaches every query about that kind of thing without a translation table
 * between event names and route names.
 *
 * It is also why `GET /api/conversation` keys on `'enquiry'`. The route and
 * the event disagree about what to call it, and the event wins, because the
 * event is the side doing the invalidating. Getting this backwards produces a
 * view that never updates while every other view does — which reads as a fault
 * in the event stream, and is not one.
 *
 * `scope` separates the collection from the item from the item's history, so a
 * list and a detail can be invalidated together by their shared `[entity]`
 * prefix or separately by `[entity, scope]`.
 */

import type { paths } from './schema';

/**
 * The `payload.entity` values tcp-server publishes. A key beginning with one
 * of these can be invalidated by a live event.
 *
 * If tcp-server gains a sixth, `query-keys.test.ts` fails here rather than a
 * view quietly going stale.
 */
export const EVENT_ENTITIES = [
  'company',
  'agent',
  'task',
  'assignment',
  'enquiry',
  'notification',
  'spend',
] as const;

/**
 * Key prefixes with no event behind them. Nothing streams a role, a member
 * list or a knowledge index, so these refetch only when their own hook asks.
 */
export const STATIC_ENTITIES = [
  'role',
  'company-user',
  'knowledge',
  'system',
] as const;

/** The second element of every key. */
export type QueryScope = 'list' | 'detail' | 'history' | 'status' | 'search';

export type EventEntity = (typeof EVENT_ENTITIES)[number];
export type StaticEntity = (typeof STATIC_ENTITIES)[number];
export type QueryEntity = EventEntity | StaticEntity;

/**
 * The query parameters a `GET` accepts, taken from the generated description.
 *
 * These are derived rather than written out. Hand-copying them looks harmless
 * and is not: `?status=` and `?mode=` are enums on the server, and restating
 * them as `string` here compiles until the call, then fails against the
 * generated types — or worse, drifts silently when tcp-server adds a value.
 * Keyed on the path, which is stable, rather than the operation id, which is
 * a controller method name.
 */
type GetQuery<P extends keyof paths> = paths[P] extends {
  get: { parameters: { query?: infer Q } };
}
  ? NonNullable<Q>
  : never;

/** Filters on `GET /api/company`. */
export type CompanyListParams = GetQuery<'/api/company'>;

/** Filters on `GET /api/agent`. */
export type AgentListParams = GetQuery<'/api/agent'>;

/** Filters on `GET /api/task`. */
export type TaskListParams = GetQuery<'/api/task'>;

/** Filters on `GET /api/assignment`. */
export type AssignmentListParams = GetQuery<'/api/assignment'>;

/** Filters on `GET /api/conversation`. */
export type ConversationListParams = GetQuery<'/api/conversation'>;

/**
 * The key builders. Every one returns a readonly tuple so a typo in a caller
 * is a type error rather than a cache miss.
 *
 * Params objects go in as they are: TanStack hashes keys with sorted object
 * properties and drops `undefined`, so `{ all: undefined }` and `{}` are the
 * same key and nothing needs normalising first.
 */
export const queryKeys = {
  companies: (params: CompanyListParams = {}) =>
    ['company', 'list', params] as const,
  company: (id: string) => ['company', 'detail', id] as const,

  agents: (params: AgentListParams = {}) => ['agent', 'list', params] as const,
  agent: (id: string) => ['agent', 'detail', id] as const,

  /**
   * Keyed under `detail`, not `list`: this holds one agent, and reusing
   * `agents({ assignmentId })` would put a scalar and an array under the same
   * key. Still prefixed `agent`, so live events patch it like any other row.
   */
  agentByAssignment: (assignmentId: string) =>
    ['agent', 'detail', { assignmentId }] as const,

  agentHistory: (id: string) => ['agent', 'history', id] as const,

  tasks: (params: TaskListParams) => ['task', 'list', params] as const,
  task: (id: string) => ['task', 'detail', id] as const,
  taskHistory: (id: string) => ['task', 'history', id] as const,

  assignments: (params: AssignmentListParams = {}) =>
    ['assignment', 'list', params] as const,
  assignment: (id: string) => ['assignment', 'detail', id] as const,

  // 'enquiry', not 'conversation' — see the note at the top of this file. The
  // route is /api/conversation; the event that invalidates these says
  // `entity: 'enquiry'`, and the key has to match the event.
  conversations: (params: ConversationListParams) =>
    ['enquiry', 'list', params] as const,
  conversation: (slug: string) => ['enquiry', 'detail', slug] as const,

  companyRoles: (companyId: string) => ['role', 'list', { companyId }] as const,
  roleBySlug: (companyId: string, slug: string) =>
    ['role', 'detail', { companyId, slug }] as const,
  role: (id: string) => ['role', 'detail', id] as const,

  companyUsers: (companyId: string) =>
    ['company-user', 'list', { companyId }] as const,

  roleKnowledge: (roleId: string) =>
    ['knowledge', 'list', { scope: 'role', roleId }] as const,
  roleKnowledgeStatus: (roleId: string) =>
    ['knowledge', 'status', { scope: 'role', roleId }] as const,
  roleKnowledgeSearch: (roleId: string, query: string) =>
    ['knowledge', 'search', { scope: 'role', roleId, query }] as const,
  companyKnowledge: (companyId: string) =>
    ['knowledge', 'list', { scope: 'company', companyId }] as const,
  companyKnowledgeStatus: (companyId: string) =>
    ['knowledge', 'status', { scope: 'company', companyId }] as const,

  /** One company's active notifications, with the application-wide ones. A dismissal patches the row in place, so there is no separate detail key. */
  notifications: (companyId: string) =>
    ['notification', 'list', { companyId }] as const,

  /** Application-wide usage totals and every provider's cap progress. */
  spendOverview: () => ['spend', 'status'] as const,
  /** One company's usage totals, per-task breakdown and recent series. */
  companySpend: (companyId: string) => ['spend', 'detail', companyId] as const,
  /** Who the caller is to the system (admin or not) and the shutdown state. */
  systemStatus: () => ['system', 'detail'] as const,
  /** The combined health of the server, agent runner and MCP servers. */
  systemHealth: () => ['system', 'status'] as const,
} as const;
