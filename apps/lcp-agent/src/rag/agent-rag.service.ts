import { EmbeddingService, LlmConfig } from '@lcp/shared';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
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
 * RAG retrieval service for lcp-agent.
 *
 * Embeds the query using {@link EmbeddingService} (shared from libs) and runs a
 * pgvector cosine similarity search against the `knowledge_chunk` table.
 * Returns an empty array when no chunks exceed the similarity threshold.
 */
@Injectable()
export class AgentRagService {
  private readonly logger = new Logger(AgentRagService.name);

  constructor(
    private readonly embedding: EmbeddingService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Returns the top-K most relevant chunks for `query` within `roleId`.
   *
   * @param roleId - Restrict search to this role's knowledge base.
   * @param query - Natural-language query string.
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

    const queryVector = await this.embedding.embedQuery(embeddingConfig, query);

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
