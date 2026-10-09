import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, ValidateNested } from 'class-validator';
import type { ModelCompatibilityResult } from '../../model-check/model-compatibility.service';
import { PROBE_ERROR_CODES, type ProbeErrorCode } from '@tcp/shared';
import { LlmConfigDto } from './llm-config.dto';

/** Body for `POST /api/model/check`. */
export class ModelCheckDto {
  /** The models to probe, each with the provider settings to reach it. */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LlmConfigDto)
  models!: LlmConfigDto[];
}

/** {@link ModelCompatibilityResult}, published as a class so the Swagger plugin can read it. */
export class ModelCompatibilityResultDto implements ModelCompatibilityResult {
  provider!: string;
  model!: string;
  /** Whether the model accepted a tool definition and returned a tool call. */
  supportsTools!: boolean;
  /** Whether the model accepted a structured-output schema and returned conforming JSON. */
  supportsStructuredOutput!: boolean;
  /** `true` iff both capabilities are confirmed. */
  compatible!: boolean;
  /** What went wrong, and what to check. Set when the check couldn't be completed. */
  error?: string;
  /** {@link error}'s category, for a client to act on. */
  @ApiProperty({ enum: PROBE_ERROR_CODES, required: false })
  errorCode?: ProbeErrorCode;
}
