import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { LlmConfigDto } from './llm-config.dto';

export class CreateCompanyDto {
  @IsString()
  @IsNotEmpty()
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

  @IsOptional()
  @IsString()
  timezone?: string;
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

  @IsOptional()
  @IsString()
  timezone?: string;
}
