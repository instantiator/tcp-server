import { LlmConfig } from '@lcp/shared';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import pgvector from 'pgvector';
import { DataSource } from 'typeorm';
import { EmbeddingService } from './embedding.service';

/** A single chunk returned by a RAG similarity search. */
export interface RagChunk {
  /** Primary key of the {@link KnowledgeChunk} row. */
  id: UUID;
  /** Path of the source document in company storage. */
  documentPath: string;
  /** Zero-based position of this chunk in its source document. */
  chunkIndex: number;
  /** Raw text content of the chunk. */
  content: string;
  /** Cosine similarity score — 1.0 is identical, 0.0 is orthogonal. */
  similarity: number;
}

/**
 * Retrieves relevant knowledge-base chunks for a role using cosine similarity.
 *
 * The query is embedded via {@link EmbeddingService} and compared against the
 * role's stored vectors using the pgvector `<=>` (cosine distance) operator.
 * Only chunks whose similarity exceeds `threshold` are returned, so the caller
 * receives an empty array when nothing relevant exists — RAG is not injected
 * into the prompt unless it adds value.
 */
@Injectable()
export class RagRetrievalService {
  private readonly logger = new Logger(RagRetrievalService.name);

  constructor(
    private readonly embedding: EmbeddingService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Returns the top-K most relevant chunks for `query` within `roleId`.
   *
   * @param roleId - Restrict search to this role's knowledge base.
   * @param query - Natural-language query string (e.g. the task prompt).
   * @param embeddingConfig - Company embedding config. Returns empty when null.
   * @param topK - Maximum number of chunks to return (default 5).
   * @param threshold - Minimum cosine similarity to include (default 0.7).
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

    const rows = await this.dataSource.query<
      {
        id: UUID;
        documentPath: string;
        chunkIndex: number;
        content: string;
        similarity: number;
      }[]
    >(
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
