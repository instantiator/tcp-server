import { ApiProperty, OmitType } from '@nestjs/swagger';
import {
  AuditEvent,
  CompanyUser,
  Conversation,
  ConversationMessage,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  TcpTask,
  type ConversationStatus,
  type MemberType,
  type MessageAuthor,
  type TcpAssignmentMode,
  type TcpAssignmentStatus,
  type TcpTaskStatus,
} from '@tcp/shared';

/**
 * The entities as they appear **on the wire**, rather than as they are
 * persisted.
 *
 * Two facts make this file necessary, and neither is visible from the models.
 *
 * **The models are documented at all only because of `nest-cli.json`.** The
 * `@nestjs/swagger` CLI plugin synthesises `@ApiProperty` metadata by reading
 * the AST, and it visits only files whose path matches one of its
 * `dtoFileNameSuffix` patterns. The entities live in
 * `libs/tcp-shared/src/models/*.model.ts`, which matched neither of the two
 * defaults, so until 006.01 every one of them was published as an empty object
 * — and openapi-typescript rendered eight of them into the web client as
 * `Record<string, never>`, a type with no properties at all. That failure is
 * silent at its cause and only surfaces as a compile error at a call site, in a
 * different package, whenever someone finally tries to read a field.
 *
 * **No relation is ever loaded on an API read path.** Nothing in
 * `libs/tcp-shared/src/models/` sets `eager`, and `relations:` appears in
 * exactly two places in this application — `chat.service.ts` and
 * `system-drain.service.ts` — neither of them serving a route. But TypeORM
 * relation properties are declared with `!` because they are required *in the
 * database*, so documenting the models unedited would publish
 * `TcpAgent.company` as a required `TcpCompany` object that is never actually
 * sent. The browser would typecheck `agent.company.name` and get `undefined` at
 * run time, which is worse than the empty schema it replaced: it fails later,
 * further away, and with the type system's endorsement.
 *
 * `OmitType` drops those properties while **copying** the rest of the metadata
 * from the model — nothing here restates a field, so a column added to an
 * entity appears in the API description with no edit to this file. The foreign
 * keys (`companyId`, `roleId`, …) are ordinary columns and are kept: they are
 * what a caller actually receives.
 *
 * `Conversation` and `CompanyUser` are absent deliberately. Both hold their
 * company as a plain `companyId` column with no `@ManyToOne`, so their models
 * already describe exactly what goes over the wire.
 */

/**
 * Enum member order, pinned.
 *
 * A string-union column reaches the OpenAPI description as an `enum`, and the
 * plugin takes its member order from the TypeScript checker — which orders a
 * union by the order its literal types happened to be instantiated during that
 * compilation, not by the order they were written. That varies between machines:
 * CI and a developer laptop generated the same three enums in different orders,
 * each matching the source declaration for some unions and not others.
 *
 * Nothing about the API changes when the order does — but `schema.d.ts` is a
 * committed generated artefact with a CI drift check, so an unstable order makes
 * that check fail at random. A gate that fails for no reason is worse than no
 * gate, because it teaches people to re-run it rather than read it.
 *
 * Naming the members explicitly removes the checker from the decision. Each
 * array is followed by an exhaustiveness check, so adding a status to the union
 * without adding it here is a compile error rather than a silently
 * under-described schema.
 *
 * `AgentStatus` needs none of this — it is a real TypeScript `enum`, whose
 * member order is fixed by its declaration. `AuditEventType` likewise derives
 * from a `const` object. Only the plain unions are unstable.
 */

/** Asserts that `Members` covers every member of `Union`. */
type Exhaustive<Union, Members extends Union> = [Union] extends [Members]
  ? true
  : never;

const TASK_STATUSES = [
  'ready',
  'planning',
  'in-progress',
  'finalising',
  'succeeded',
  'failed',
  'cancelled',
] as const satisfies readonly TcpTaskStatus[];
const _taskStatusesExhaustive: Exhaustive<
  TcpTaskStatus,
  (typeof TASK_STATUSES)[number]
> = true;
void _taskStatusesExhaustive;

const ASSIGNMENT_MODES = [
  'plan',
  'implement',
  'qa',
  'chat',
  'consultee',
  'finalise',
] as const satisfies readonly TcpAssignmentMode[];
const _assignmentModesExhaustive: Exhaustive<
  TcpAssignmentMode,
  (typeof ASSIGNMENT_MODES)[number]
> = true;
void _assignmentModesExhaustive;

const ASSIGNMENT_STATUSES = [
  'ready',
  'in-progress',
  'in-qa',
  'succeeded',
  'failed',
  'cancelled',
] as const satisfies readonly TcpAssignmentStatus[];
const _assignmentStatusesExhaustive: Exhaustive<
  TcpAssignmentStatus,
  (typeof ASSIGNMENT_STATUSES)[number]
> = true;
void _assignmentStatusesExhaustive;

const CONVERSATION_STATUSES = [
  'awaiting_user',
  'closed',
] as const satisfies readonly ConversationStatus[];
const _conversationStatusesExhaustive: Exhaustive<
  ConversationStatus,
  (typeof CONVERSATION_STATUSES)[number]
> = true;
void _conversationStatusesExhaustive;

const MESSAGE_AUTHORS = [
  'user',
  'agent',
] as const satisfies readonly MessageAuthor[];
const _messageAuthorsExhaustive: Exhaustive<
  MessageAuthor,
  (typeof MESSAGE_AUTHORS)[number]
> = true;
void _messageAuthorsExhaustive;

const MEMBER_TYPES = [
  'creator',
  'owner',
  'member',
] as const satisfies readonly MemberType[];
const _memberTypesExhaustive: Exhaustive<
  MemberType,
  (typeof MEMBER_TYPES)[number]
> = true;
void _memberTypesExhaustive;

/** {@link TcpCompany} minus its unloaded `plannerRole` relation. */
export class CompanyResponseDto extends OmitType(TcpCompany, [
  'plannerRole',
] as const) {}

/** {@link TcpRole} minus its unloaded `company` relation. */
export class RoleResponseDto extends OmitType(TcpRole, ['company'] as const) {}

/** {@link TcpTask} minus its unloaded relations. */
export class TaskResponseDto extends OmitType(TcpTask, [
  'company',
  'plannerRole',
] as const) {
  @ApiProperty({ enum: TASK_STATUSES })
  declare status: TcpTaskStatus;
}

/** {@link TcpAgent} minus its unloaded relations. */
export class AgentResponseDto extends OmitType(TcpAgent, [
  'company',
  'role',
  'assignment',
] as const) {}

/** {@link TcpAssignment} minus its unloaded relations. */
export class AssignmentResponseDto extends OmitType(TcpAssignment, [
  'company',
  'role',
  'task',
  'agent',
  'targetAssignment',
  'parentAssignment',
] as const) {
  @ApiProperty({ enum: ASSIGNMENT_MODES })
  declare mode: TcpAssignmentMode;

  @ApiProperty({ enum: ASSIGNMENT_STATUSES })
  declare status: TcpAssignmentStatus;
}

/** {@link AuditEvent} minus its unloaded relations. */
export class AuditEventResponseDto extends OmitType(AuditEvent, [
  'company',
  'agent',
] as const) {}

/**
 * {@link Conversation} and {@link CompanyUser} carry no relations, so these
 * exist only to pin an enum order. Documented through a DTO rather than the
 * model directly, because the pin has to live somewhere the browser bundle
 * never imports — a `@nestjs/swagger` decorator on a shared model would.
 */
export class ConversationResponseDto extends OmitType(
  Conversation,
  [] as const,
) {
  @ApiProperty({ enum: CONVERSATION_STATUSES })
  declare status: ConversationStatus;
}

/** {@link CompanyUser}, with its `memberType` enum order pinned. */
export class CompanyUserResponseDto extends OmitType(CompanyUser, [] as const) {
  @ApiProperty({ enum: MEMBER_TYPES })
  declare memberType: MemberType;
}

/** {@link ConversationMessage}, with its `author` enum order pinned. */
export class ConversationMessageResponseDto extends OmitType(
  ConversationMessage,
  [] as const,
) {
  @ApiProperty({ enum: MESSAGE_AUTHORS })
  declare author: MessageAuthor;
}

/**
 * The two detail routes below answer with an entity **and** what a caller
 * would otherwise have to fetch separately.
 *
 * They are the entity's own fields at the top level, with the extras beside
 * them — deliberately not `{ task, assignments }` and
 * `{ conversation, messages }`, which is what both handlers returned until
 * 007.02. A wrapper has no top-level `id`, and the browser's live-event cache
 * patches a cached object by matching `id` (`applyEvent` in the web client, see
 * [ADR-030](../../../../../../docs/ADRs/ADR-030-component-hooks-for-live-data.md)).
 * So a wrapper is not merely awkward to read — it silently cannot be updated by
 * an event, which is the one thing these routes exist to support. Keep the id
 * at the top.
 */

/** {@link TaskResponseDto} plus the assignments working it. */
export class TaskDetailResponseDto extends TaskResponseDto {
  @ApiProperty({ type: AssignmentResponseDto, isArray: true })
  assignments!: AssignmentResponseDto[];
}

/** {@link ConversationResponseDto} plus its messages and display timezone. */
export class ConversationDetailResponseDto extends ConversationResponseDto {
  @ApiProperty({ type: ConversationMessageResponseDto, isArray: true })
  messages!: ConversationMessageResponseDto[];

  /**
   * The owning company's timezone, for formatting the timestamps below.
   * Timestamps themselves are always UTC.
   */
  @ApiProperty({ type: String, nullable: true })
  companyTimezone!: string | null;
}
