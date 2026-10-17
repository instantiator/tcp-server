import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** One application-level default model, without its key or address. */
export class LlmDefaultDto {
  provider!: string;
  model!: string;
  @ApiPropertyOptional()
  contextWindow?: number;
}

/** The application's default models (env config), for the web picker's fallback labels. */
export class LlmDefaultsDto {
  @ApiProperty({ type: LlmDefaultDto, nullable: true })
  chat!: LlmDefaultDto | null;

  @ApiProperty({ type: LlmDefaultDto, nullable: true })
  embedding!: LlmDefaultDto | null;

  /** Width of the vectors this deployment stores (EMBEDDING_DIMENSION). */
  embeddingDimension!: number;
}
