import type { UUID } from 'crypto';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateIf,
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

  /** Required when type === 'agent_consultation'. */
  @ValidateIf((o: PauseDto) => o.type === 'agent_consultation')
  @IsUUID()
  companyId?: UUID;

  /** Required when type === 'agent_consultation'. */
  @ValidateIf((o: PauseDto) => o.type === 'agent_consultation')
  @IsString()
  @IsNotEmpty()
  roleName?: string;
}

export class CompleteDto {
  @IsString()
  output!: string;
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
