import type { UUID } from 'crypto';
import type { McpServerToggles } from '@tcp/shared';
import { IsMcpServerToggles } from './is-mcp-server-toggles.validator';
import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { IsNotUuid } from './is-not-uuid.validator';
import {
  IsIanaTimeZone,
  normalizeIanaTimeZone,
} from './is-valid-timezone.validator';
import { LlmConfigDto } from './llm-config.dto';

export class CreateCompanyDto {
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
  @ValidateNested()
  @Type(() => LlmConfigDto)
  llmConfig?: LlmConfigDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => LlmConfigDto)
  embeddingConfig?: LlmConfigDto;

  @IsOptional()
  @IsString()
  companyContext?: string;

  @IsOptional()
  @IsString()
  systemPromptTemplate?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mcpServerList?: string[];

  /** MCP servers switched on or off, by name; `null` clears every toggle. */
  @IsOptional()
  @IsMcpServerToggles()
  mcpServerToggles?: McpServerToggles | null;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizeIanaTimeZone(value))
  @IsIanaTimeZone()
  timezone?: string;

  @IsOptional()
  @IsUUID()
  plannerRoleId?: UUID;
}

export class UpdateCompanyDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  description?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => LlmConfigDto)
  llmConfig?: LlmConfigDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => LlmConfigDto)
  embeddingConfig?: LlmConfigDto;

  @IsOptional()
  @IsString()
  companyContext?: string;

  @IsOptional()
  @IsString()
  systemPromptTemplate?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mcpServerList?: string[];

  /** MCP servers switched on or off, by name; `null` clears every toggle. */
  @IsOptional()
  @IsMcpServerToggles()
  mcpServerToggles?: McpServerToggles | null;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizeIanaTimeZone(value))
  @IsIanaTimeZone()
  timezone?: string;

  @IsOptional()
  @IsUUID()
  plannerRoleId?: UUID;
}
