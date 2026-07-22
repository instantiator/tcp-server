import { OpenAIEmbeddings } from '@langchain/openai';
import { Injectable } from '@nestjs/common';
import type { LlmConfig } from '../models/LlmConfig.model';

/**
 * Generates text embeddings using an OpenAI-compatible embeddings API.
 *
 * The provider config follows the same {@link LlmConfig} shape as the chat LLM
 * so that operators can point it at LM Studio, OpenAI, or any compatible endpoint.
 * Shared across lcp-server, lcp-agent, and lcp-mcp-memory.
 */
@Injectable()
export class EmbeddingService {
  /** Embeds a batch of text strings. The returned arrays are in the same order as `texts`. */
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
      // The underlying `openai` SDK defaults to requesting `base64` encoding
      // (client-side, for transport efficiency) when this isn't set. Real
      // OpenAI honours that; many OpenAI-compatible local servers (LM Studio
      // included, at least as of this writing) silently ignore the
      // `encoding_format` request param and always return plain JSON floats
      // — but the SDK still *assumes* base64 came back and misinterprets the
      // response, reinterpreting every 4 floats as a byte-encoded one
      // (yielding vectors a quarter of the real length, silently corrupt,
      // no error). `'float'` is equally valid against real OpenAI, so this
      // is safe to set unconditionally rather than only for local providers.
      encodingFormat: 'float',
    });
  }
}
