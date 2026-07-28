import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import pgvector from 'pgvector';
import { DataSource } from 'typeorm';
import { DEFAULT_RAG_THRESHOLD } from '../config/defaults';
import type { LlmConfig } from '../models/LlmConfig.model';
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
 *
 * Shared by tcp-server, tcp-agent and tcp-mcp-memory so all three retrieve on
 * identical scoping and threshold rules.
 */
@Injectable()
export class KnowledgeRetrievalService {
  private readonly logger = new Logger(KnowledgeRetrievalService.name);

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
   * @param query - Natural-language query string (e.g. the task prompt).
   * @param embeddingConfig - Company embedding config. Returns empty when null.
   * @param topK - Maximum number of chunks to return (default 5).
   * @param threshold - Minimum cosine similarity to include. Defaults to
   *   {@link DEFAULT_RAG_THRESHOLD}; callers with a role/company in hand pass
   *   the value resolved through their `runConfig` cascade instead.
   */
  async retrieve(
    roleId: UUID,
    companyId: UUID,
    query: string,
    embeddingConfig: LlmConfig | null | undefined,
    topK = 5,
    threshold = DEFAULT_RAG_THRESHOLD,
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
}
