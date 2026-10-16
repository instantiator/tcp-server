import { ApiProperty } from '@nestjs/swagger';
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

  /** MCP servers switched on or off, by name; `null` clears every toggle. */
  @IsOptional()
  @IsMcpServerToggles()
  mcpServerToggles?: McpServerToggles | null;

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

  /** MCP servers switched on or off, by name; `null` clears every toggle. */
  @IsOptional()
  @IsMcpServerToggles()
  mcpServerToggles?: McpServerToggles | null;

  /** The role's own model; `null` clears it, so the role uses the company's. */
  @ApiProperty({ type: LlmConfigDto, nullable: true, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => LlmConfigDto)
  llmConfig?: LlmConfigDto | null;

  @IsOptional()
  @IsString()
  rolePrompt?: string;
}
