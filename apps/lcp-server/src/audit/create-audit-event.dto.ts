import { AuditEventType } from '@lcp/shared';
import type { UUID } from 'crypto';
import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

const AUDIT_EVENT_TYPES = Object.values(AuditEventType);

/**
 * Request body for POST /internal/audit.
 *
 * Every field needs at least one class-validator decorator — the global
 * `ValidationPipe({ whitelist: true })` (see AppModule) strips any property
 * with none, silently turning an otherwise-correct request body into an
 * empty object and failing the entity's NOT NULL constraints server-side.
 */
export class CreateAuditEventDto {
  @IsUUID()
  companyId!: UUID;

  /** Denormalised role name at the time of the event. */
  @IsString()
  @IsNotEmpty()
  role!: string;

  @IsOptional()
  @IsUUID()
  agentId?: UUID;

  @IsIn(AUDIT_EVENT_TYPES)
  eventType!: AuditEventType;

  @IsObject()
  payload!: Record<string, unknown>;
}
