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
import { LlmConfigDto } from './llm-config.dto';

export class CreateRoleDto {
  @IsUUID()
  companyId!: UUID;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  description!: string;

  @IsString()
  @IsNotEmpty()
  systemPromptTemplate!: string;

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
