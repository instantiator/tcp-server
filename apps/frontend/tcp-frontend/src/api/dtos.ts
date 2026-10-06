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
