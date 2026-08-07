import type { UUID } from 'crypto';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class PauseDto {
  @IsIn(['user_input', 'agent_consultation'])
  type!: 'user_input' | 'agent_consultation';

  @IsUUID()
  agentId!: UUID;

  @IsString()
  @IsNotEmpty()
  question!: string;

  @IsOptional()
  @IsString()
  context?: string;

  /**
   * Required when type === 'agent_consultation', unless `companySlug` is
   * given instead — the controller resolves whichever is present and 400s
   * if neither is.
   */
  @IsOptional()
  @IsUUID()
  companyId?: UUID;

  /** Alternate to `companyId` — resolved the same way `TcpCompany.slug` is elsewhere. */
  @IsOptional()
  @IsString()
  companySlug?: string;

  /**
   * Required when type === 'agent_consultation', unless `roleSlug` is given
   * instead. Role slugs are scoped to the resolved company.
   */
  @IsOptional()
  @IsUUID()
  roleId?: UUID;

  /** Alternate to `roleId` — resolved against the company from `companyId`/`companySlug`. */
  @IsOptional()
  @IsString()
  roleSlug?: string;

  /** Optional human-readable label, used only for friendlier error messages. */
  @IsOptional()
  @IsString()
  roleName?: string;

  /** Optional, type === 'user_input' only — targets specific company users instead of auto-routing. */
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  userIds?: UUID[];
}

export class CompleteDto {
  @IsString()
  output!: string;
}

/** Body for `POST /internal/agent/:agentId/fail`. */
export class FailDto {
  @IsString()
  @IsNotEmpty()
  reason!: string;
}

/** Body for `PATCH /internal/agent/:agentId/storage`. */
export class UpdateStorageChangesDto {
  @IsOptional()
  @IsArray()
  created?: string[];

  @IsOptional()
  @IsArray()
  modified?: string[];

  @IsOptional()
  @IsArray()
  deleted?: string[];

  @IsOptional()
  @IsArray()
  moved?: { from: string; to: string }[];
}
