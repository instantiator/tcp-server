import type { LlmConfig } from '@tcp/shared/client';
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
export type StorageFolderDTO = components['schemas']['StorageFolderDto'];
export type StorageFolderEntryDTO =
  components['schemas']['StorageFolderEntryDto'];
export type StorageFileEntryDTO = components['schemas']['StorageFileEntryDto'];
export type StorageVersionDTO = components['schemas']['StorageVersionDto'];
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
/** A column to add to a record table (001.06). */
export type AddColumn = components['schemas']['AddColumnDto'];
/** A column's new type (001.06). */
export type RetypeColumn = components['schemas']['RetypeColumnDto'];
export type DoNotStoreEntry = components['schemas']['DoNotStoreEntryDto'];

/** What importing a company template would do, before anything is created (002.03). */
export type CompanyTemplatePreview =
  components['schemas']['CompanyTemplatePreviewDto'];
/** One template in the gallery, with the source it came from. */
export type GalleryTemplate = components['schemas']['GalleryTemplateDto'];
/** A place the gallery reads templates from (002.03). */
export type TemplateSourceDTO = components['schemas']['TemplateSourceDto'];
/** A GitHub repository to add as a template source. */
export type AddTemplateSource = components['schemas']['AddTemplateSourceDto'];
/**
 * The importer's choices, sent as the `options` JSON field. The generated
 * schema types that field as a bare string, so the shape is written here from
 * `ImportCompanyOptionsDto` on the server.
 */
export interface ImportCompanyOptions {
  readonly slug?: string;
  readonly name?: string;
  readonly description?: string;
  readonly timezone?: string;
  readonly companyContext?: string | null;
  readonly llmConfig?: LlmConfig | null;
  readonly embeddingConfig?: LlmConfig | null;
  /** `false` for a role that should inherit rather than use the template's model. */
  readonly roleModels?: Readonly<Record<string, boolean>>;
  readonly replace?: boolean;
}
