import { OmitType } from '@nestjs/swagger';
import {
  AuditEvent,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  TcpTask,
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
] as const) {}

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
] as const) {}

/** {@link AuditEvent} minus its unloaded relations. */
export class AuditEventResponseDto extends OmitType(AuditEvent, [
  'company',
  'agent',
] as const) {}
