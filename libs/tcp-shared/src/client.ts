/**
 * The browser-safe surface of `@tcp/shared`, reached as `@tcp/shared/client`.
 *
 * `./src/index.ts` — the default export — re-exports TypeORM entities, NestJS
 * modules, BullMQ and ioredis clients and MinIO helpers. None of that can run
 * in a browser, and a bundler that meets it fails late and illegibly. This
 * file is the surface the web client is allowed to see (ADR-022).
 *
 * ## The rule for adding to this file
 *
 * Everything here must survive type erasure with **no runtime import**:
 *
 * - Model exports are `export type` only. The model classes carry `@Entity`
 *   and `@Column`, so importing one as a *value* evaluates its module and
 *   drags `typeorm` into the bundle. `export type` is erased at emit, so the
 *   declaration disappears entirely and nothing is imported.
 * - A **value** may only be exported if its module imports nothing at runtime.
 *   The wire-event helpers below qualify: `events/wire-events.ts` uses
 *   `import type` exclusively, and its exported functions are pure.
 *
 * Adding a value export from a module that has a runtime import is the one
 * mistake this file exists to prevent. Check the whole import graph, not just
 * the immediate file.
 */

// -- Wire events: the SSE/Redis payload contract, shared by the CLI and web --
// wire-events.ts imports only types, so its helpers are safe as values.
export type {
  WireEvent,
  AuditWireEvent,
  StreamDelta,
  TaskChangeSummary,
  AssignmentChangeSummary,
  AgentChangeSummary,
  EnquiryChangeSummary,
} from './events/wire-events';
export {
  buildTaskChangeSummary,
  buildAssignmentChangeSummary,
  buildAgentChangeSummary,
  buildEnquiryChangeSummary,
  agentEventsChannel,
  taskEventsChannel,
  companyEventsChannel,
} from './events/wire-events';
export { parseWireEvents, readWireStream } from './events/wire-stream';
export type { StreamEnd } from './events/wire-stream';
export {
  str,
  planIndexFromShortcode,
  parseTaskChangeSummary,
} from './events/wire-parse';

// -- Company statistics: the `GET /api/company` response shape ---------------
// CompanyStats.model.ts imports only types, so its helper is safe as a value.
export type {
  CompanyStats,
  CompanyListItem,
} from './models/CompanyStats.model';
export { emptyCompanyStats } from './models/CompanyStats.model';

// -- Model types used as API DTOs -------------------------------------------
// Types only. `AuditEventType` and `AgentStatus` also exist at runtime (a
// const object and an enum respectively), but their modules import typeorm,
// so only the type side crosses this boundary. If the web client needs one of
// them as a value, extract it to its own import-free module first.
export type { AgentRunConfig } from './models/AgentRunConfig.model';
export type {
  AuditEvent,
  AuditEventType,
  AgentLoopCompletionSummary,
} from './models/AuditEvent.model';
export type { CompanyUser, MemberType } from './models/CompanyUser.model';
export type {
  Conversation,
  ConversationStatus,
} from './models/Conversation.model';
export type {
  ConversationMessage,
  MessageAuthor,
} from './models/ConversationMessage.model';
export type { EpisodicMemory } from './models/EpisodicMemory.model';
export type { KnowledgeChunk } from './models/KnowledgeChunk.model';
export type { KnowledgeIndexState } from './models/KnowledgeIndexState.model';
export type { LlmConfig } from './models/LlmConfig.model';
export type {
  PendingConsultation,
  ConsultationStatus,
} from './models/PendingConsultation.model';
export type {
  TcpAgent,
  AgentStatus,
  PauseReason,
} from './models/TcpAgent.model';
export type {
  TcpArtifact,
  TcpArtifactType,
  TcpMaterialArtifact,
  TcpAssignmentWorkingArtifact,
  TcpAssignmentCompletedArtifact,
  TcpTaskCompletedArtifact,
} from './models/TcpArtifact';
export type {
  TcpAssignment,
  TcpAssignmentMode,
  TcpAssignmentStatus,
  TcpAssignmentQaStatus,
} from './models/TcpAssignment.model';
export type { TcpCompany } from './models/TcpCompany.model';
export type { TcpRole } from './models/TcpRole.model';
export type { TcpTask, TcpTaskStatus } from './models/TcpTask.model';
export type { VersionedEntity } from './models/VersionedEntity';
export type { WithLlmConfig } from './models/WithLlmConfig';
export type { WithEmbeddingConfig } from './models/WithEmbeddingConfig';
