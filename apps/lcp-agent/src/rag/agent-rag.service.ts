import { LlmConfig } from '@lcp/shared';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { OpenAIEmbeddings } from '@langchain/openai';
import { UUID } from 'crypto';
import pgvector from 'pgvector';
import { DataSource } from 'typeorm';

/** A single knowledge-base chunk returned by similarity search. */
export interface RagChunk {
  id: UUID;
  documentPath: string;
  chunkIndex: number;
  content: string;
  similarity: number;
}

/**
 * Minimal RAG retrieval service for lcp-agent.
 *
 * Embeds the query using the company's {@link LlmConfig.embeddingConfig} and
 * runs a pgvector cosine similarity search against the `knowledge_chunk` table.
 * Returns an empty array when no chunks exceed the similarity threshold, so
 * the agent prompt is not augmented with irrelevant content.
 *
 * This service mirrors {@link RagRetrievalService} in lcp-server but is kept
 * separate to avoid an HTTP round-trip between lcp-agent and lcp-server.
 */
@Injectable()
export class AgentRagService {
  private readonly logger = new Logger(AgentRagService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Returns the top-K most relevant chunks for `query` within `roleId`.
   *
   * @param roleId - Restrict search to this role's knowledge base.
   * @param query - Natural-language query string (e.g. `agent.initialPrompt`).
   * @param embeddingConfig - Company embedding config. Returns empty when null.
   * @param topK - Maximum chunks to return (default 5).
   * @param threshold - Minimum cosine similarity (default 0.7).
   */
  async retrieve(
    roleId: UUID,
    query: string,
    embeddingConfig: LlmConfig | null | undefined,
    topK = 5,
    threshold = 0.7,
  ): Promise<RagChunk[]> {
    if (!embeddingConfig) return [];

    const embeddings = new OpenAIEmbeddings({
      model: embeddingConfig.model,
      apiKey: embeddingConfig.apiKey ?? 'lcp',
      configuration: embeddingConfig.baseUrl
        ? { baseURL: embeddingConfig.baseUrl }
        : undefined,
    });
    const queryVector = await embeddings.embedQuery(query);

    const rows = await this.dataSource.query<RagChunk[]>(
      `SELECT id, "documentPath", "chunkIndex", content,
              1 - (embedding <=> $1::vector) AS similarity
       FROM knowledge_chunk
       WHERE "roleId" = $2
         AND embedding IS NOT NULL
         AND 1 - (embedding <=> $1::vector) >= $3
       ORDER BY similarity DESC
       LIMIT $4`,
      [pgvector.toSql(queryVector), roleId, threshold, topK],
    );

    this.logger.debug(
      `RAG: ${rows.length} chunk(s) above threshold ${threshold} for role ${roleId}`,
    );
    return rows;
  }
}
