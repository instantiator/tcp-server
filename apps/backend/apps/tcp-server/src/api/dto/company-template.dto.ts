import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { SLUG } from '../../templates/company-template/format';
import {
  IsIanaTimeZone,
  normalizeIanaTimeZone,
} from './is-valid-timezone.validator';
import { LlmConfigDto } from './llm-config.dto';

/**
 * What the importer changes from the template. An absent field keeps the
 * template's value; `null` clears it.
 */
export class ImportCompanyOptionsDto {
  /** The company's address; defaults to the template's slug. */
  @IsOptional()
  @Matches(SLUG, {
    message: 'slug must be lower-case letters and digits joined by hyphens',
  })
  slug?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  description?: string;

  @ApiProperty({ type: String, nullable: true, required: false })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizeIanaTimeZone(value))
  @IsIanaTimeZone()
  timezone?: string | null;

  @ApiProperty({ type: String, nullable: true, required: false })
  @IsOptional()
  @IsString()
  companyContext?: string | null;

  /** The company's model, replacing the template's; `null` for none. */
  @ApiProperty({ type: LlmConfigDto, nullable: true, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => LlmConfigDto)
  llmConfig?: LlmConfigDto | null;

  /** The company's embedding model, replacing the template's; `null` for none. */
  @ApiProperty({ type: LlmConfigDto, nullable: true, required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => LlmConfigDto)
  embeddingConfig?: LlmConfigDto | null;

  /** By role slug: `false` imports that role without its own model. */
  @ApiProperty({ type: 'object', additionalProperties: { type: 'boolean' } })
  @IsOptional()
  @IsObject()
  roleModels?: Record<string, boolean>;

  /** Replace an existing company at this slug (members and admins only). */
  @IsOptional()
  @IsBoolean()
  replace?: boolean;
}

/** A knowledge document in a template, and its licence where known. */
export class TemplateDocumentPreviewDto {
  /** `shared` for company-wide knowledge, otherwise the role's slug. */
  scope!: string;
  name!: string;
  license?: string;
  source?: string;
}

/** A role in a template. */
export class TemplateRolePreviewDto {
  slug!: string;
  name!: string;
  description!: string;
  @ApiProperty({ type: LlmConfigDto, nullable: true })
  llmConfig!: LlmConfigDto | null;
  /** How many knowledge documents the role brings. */
  documents!: number;
}

/** The company fields a template sets. No model carries a key. */
export class TemplateCompanyPreviewDto {
  slug!: string;
  name!: string;
  description!: string;
  @ApiProperty({ type: String, nullable: true })
  timezone!: string | null;
  @ApiProperty({ type: String, nullable: true })
  companyContext!: string | null;
  @ApiProperty({ type: LlmConfigDto, nullable: true })
  llmConfig!: LlmConfigDto | null;
  @ApiProperty({ type: LlmConfigDto, nullable: true })
  embeddingConfig!: LlmConfigDto | null;
}

/** What a template would create, shown before importing it. */
export class CompanyTemplatePreviewDto {
  formatVersion!: number;
  company!: TemplateCompanyPreviewDto;
  /** The slug of the role that becomes the default planner, if any. */
  @ApiProperty({ type: String, nullable: true })
  plannerRole!: string | null;
  roles!: TemplateRolePreviewDto[];
  documents!: TemplateDocumentPreviewDto[];
  /** Names of the providers the template's models need a key for. */
  neededKeys!: string[];
  /** Whether a company already holds the template's slug. */
  slugTaken!: boolean;
  /** Things the importer should know, such as an API key that was dropped. */
  warnings!: string[];
}
