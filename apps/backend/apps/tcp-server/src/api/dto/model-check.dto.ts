import { Type } from 'class-transformer';
import { IsArray, ValidateNested } from 'class-validator';
import type { ModelCompatibilityResult } from '../../model-check/model-compatibility.service';
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
  /** Set when the live check could not be completed (network error, bad config, etc.). */
  error?: string;
}
