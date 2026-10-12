import type { components } from './schema';

export type CompanyDTO = components['schemas']['CompanyResponseDto'];
export type AgentDTO = components['schemas']['AgentResponseDto'];
export type RoleDTO = components['schemas']['RoleResponseDto'];
export type TaskDTO = components['schemas']['TaskResponseDto'];
/** {@link TaskDTO} plus the assignments working it — `GET /api/task/{id}` only. */
export type TaskDetailDTO = components['schemas']['TaskDetailResponseDto'];
export type AssignmentDTO = components['schemas']['AssignmentResponseDto'];
export type ConversationDTO = components['schemas']['ConversationResponseDto'];
/** {@link ConversationDTO} plus its messages — `GET /api/conversation/{slug}` only. */
export type ConversationDetailDTO =
  components['schemas']['ConversationDetailResponseDto'];
export type KnowledgeDocumentDTO =
  components['schemas']['KnowledgeDocumentResponseDto'];
export type SpendOverviewDTO = components['schemas']['SpendOverviewDto'];
export type CompanySpendDTO = components['schemas']['CompanySpendDto'];
export type NotificationDTO = components['schemas']['TcpNotification'];

export type RecordTableSummary = components['schemas']['RecordTableSummaryDto'];
export type RecordTableRows = components['schemas']['RecordTableRowsDto'];
export type RecordTableDefinition =
  components['schemas']['RecordTableDefinitionDto'];
export type RecordFieldSchema = components['schemas']['RecordFieldSchemaDto'];
export type TimedRecord = components['schemas']['TimedRecordDto'];
export type AppendRecordsCsvResult =
  components['schemas']['AppendRecordsCsvResultDto'];
export type RecordTableRetention =
  components['schemas']['RecordTableRetentionDto'];
export type RecordSearchResult = components['schemas']['RecordSearchResultDto'];
export type DoNotStoreEntry = components['schemas']['DoNotStoreEntryDto'];
