import type { UUID } from 'crypto';
import type { McpServerToggles } from '@tcp/shared';
import { ApiProperty } from '@nestjs/swagger';
import { IsMcpServerToggles } from './is-mcp-server-toggles.validator';
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
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

  /** Days old file versions are kept; `null` uses the app default. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  versionRetentionDays?: number | null;

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

  /** The company's default model; `null` clears it. */
  @ApiProperty({ type: LlmConfigDto, nullable: true, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => LlmConfigDto)
  llmConfig?: LlmConfigDto | null;

  /** The company's embedding model; `null` clears it. */
  @ApiProperty({ type: LlmConfigDto, nullable: true, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => LlmConfigDto)
  embeddingConfig?: LlmConfigDto | null;

  /** Prompt part 2 for every agent; `null` leaves it out. */
  @ApiProperty({ type: String, nullable: true, required: false })
  @IsOptional()
  @IsString()
  companyContext?: string | null;

  /** The default for roles without their own; `null` uses the built-in one. */
  @ApiProperty({ type: String, nullable: true, required: false })
  @IsOptional()
  @IsString()
  systemPromptTemplate?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mcpServerList?: string[];

  /** MCP servers switched on or off, by name; `null` clears every toggle. */
  @IsOptional()
  @IsMcpServerToggles()
  mcpServerToggles?: McpServerToggles | null;

  /** Days old file versions are kept; `null` uses the app default. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  versionRetentionDays?: number | null;

  /** IANA zone name, for display; `null` clears it. */
  @ApiProperty({ type: String, nullable: true, required: false })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizeIanaTimeZone(value))
  @IsIanaTimeZone()
  timezone?: string | null;

  /** The default planner, one of this company's roles; `null` clears it. */
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    required: false,
  })
  @IsOptional()
  @IsUUID()
  plannerRoleId?: UUID | null;
}
