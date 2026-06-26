import { AuditEventType } from '@lcp/shared';
import type { UUID } from 'crypto';

/** Request body for POST /internal/audit. */
export class CreateAuditEventDto {
  companyId!: UUID;
  /** Denormalised role name at the time of the event. */
  role!: string;
  agentId?: UUID;
  eventType!: AuditEventType;
  payload!: Record<string, unknown>;
}
