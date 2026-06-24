import { OpenAIEmbeddings } from '@langchain/openai';
import { LlmConfig } from '@lcp/shared';
import { Injectable } from '@nestjs/common';

/**
 * Generates text embeddings using an OpenAI-compatible embeddings API.
 *
 * The provider config follows the same {@link LlmConfig} shape as the chat LLM
 * so that operators can point it at LM Studio, OpenAI, or any compatible endpoint.
 * Use {@link EmbeddingService.embedTexts} for batch ingestion and
 * {@link EmbeddingService.embedQuery} for single-string retrieval queries.
 */
@Injectable()
export class EmbeddingService {
  /**
   * Embeds a batch of text strings and returns one float array per input.
   * The returned arrays are in the same order as `texts`.
   */
  async embedTexts(config: LlmConfig, texts: string[]): Promise<number[][]> {
    return this.build(config).embedDocuments(texts);
  }

  /** Embeds a single query string for similarity search. */
  async embedQuery(config: LlmConfig, text: string): Promise<number[]> {
    return this.build(config).embedQuery(text);
  }

  private build(config: LlmConfig): OpenAIEmbeddings {
    return new OpenAIEmbeddings({
      model: config.model,
      apiKey: config.apiKey ?? 'lcp',
      configuration: config.baseUrl ? { baseURL: config.baseUrl } : undefined,
    });
  }
}
