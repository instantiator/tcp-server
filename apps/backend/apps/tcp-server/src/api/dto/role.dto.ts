import type { UUID } from 'crypto';
import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { IsNotUuid } from './is-not-uuid.validator';
import { LlmConfigDto } from './llm-config.dto';

export class CreateRoleDto {
  @IsUUID()
  companyId!: UUID;

  @IsString()
  @IsNotEmpty()
  @IsNotUuid()
  slug!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  description!: string;

  @IsOptional()
  @IsString()
  systemPromptTemplate?: string;

  @IsArray()
  @IsString({ each: true })
  knowledgeDomains!: string[];

  @IsArray()
  @IsString({ each: true })
  mcpServerList!: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => LlmConfigDto)
  llmConfig?: LlmConfigDto;

  @IsOptional()
  @IsString()
  rolePrompt?: string;
}

export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @IsNotUuid()
  slug?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  description?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  systemPromptTemplate?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  knowledgeDomains?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mcpServerList?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => LlmConfigDto)
  llmConfig?: LlmConfigDto;

  @IsOptional()
  @IsString()
  rolePrompt?: string;
}
