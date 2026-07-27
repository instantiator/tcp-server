import { EmbeddingService, LlmConfig } from '@tcp/shared';
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
   * Returns the top-K most relevant chunks for `query`, searching the role's
   * own knowledge base **plus** its company's shared (`roleId IS NULL`) chunks.
   *
   * @param roleId - The querying role, whose chunks are searched.
   * @param companyId - The role's company, whose shared chunks are also searched.
   * @param query - Natural-language query string.
   * @param embeddingConfig - Company embedding config. Returns empty when null.
   * @param topK - Maximum chunks to return (default 5).
   * @param threshold - Minimum cosine similarity (default 0.7).
   */
  async retrieve(
    roleId: UUID,
    companyId: UUID,
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
       WHERE (("roleId" = $2) OR ("roleId" IS NULL AND "companyId" = $3))
         AND embedding IS NOT NULL
         AND 1 - (embedding <=> $1::vector) >= $4
       ORDER BY similarity DESC
       LIMIT $5`,
      [pgvector.toSql(queryVector), roleId, companyId, threshold, topK],
    );

    this.logger.debug(
      `RAG: ${rows.length} chunk(s) above threshold ${threshold} for role ${roleId} + shared`,
    );
    return rows;
  }

  /**
   * Whether the role has any indexed knowledge — its own chunks or its
   * company's shared (`roleId IS NULL`) chunks. A cheap indexed existence
   * check (no embedding call), used to decide whether to offer the knowledge
   * (memory) service and run RAG retrieval at all: a role with an empty
   * knowledge base gets neither, saving turns and tokens.
   */
  async hasKnowledge(roleId: UUID, companyId: UUID): Promise<boolean> {
    const rows = await this.dataSource.query<{ exists: boolean }[]>(
      `SELECT EXISTS (
         SELECT 1 FROM knowledge_chunk
         WHERE ("roleId" = $1) OR ("roleId" IS NULL AND "companyId" = $2)
       ) AS exists`,
      [roleId, companyId],
    );
    return rows[0]?.exists ?? false;
  }
}
