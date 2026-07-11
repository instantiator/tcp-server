import { KnowledgeChunk, LlmConfig } from '@lcp/shared';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import pgvector from 'pgvector';
import { DataSource, IsNull, Repository } from 'typeorm';
import { EmbeddingService } from './embedding.service';

/** Maximum characters per chunk before splitting (≈ 400–600 tokens at 4 chars/token). */
const MAX_CHUNK_CHARS = 2000;

/**
 * Ingests and removes OKF knowledge-base documents for a role, or for a
 * company's shared knowledge (when `roleId` is `null`).
 *
 * On ingest, the document is split into chunks, each chunk is embedded via
 * {@link EmbeddingService}, and all rows are written to the `knowledge_chunk`
 * table. Existing chunks for the same `documentPath` are deleted first so that
 * re-indexing a document always produces a consistent set of chunks.
 *
 * Vector writes use raw SQL because TypeORM does not support the pgvector
 * `vector` column type natively.
 */
@Injectable()
export class RagIndexService {
  private readonly logger = new Logger(RagIndexService.name);

  constructor(
    private readonly embedding: EmbeddingService,
    @InjectRepository(KnowledgeChunk)
    private readonly chunkRepo: Repository<KnowledgeChunk>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Indexes a document for RAG retrieval.
   *
   * Splits `content` into overlapping chunks, embeds each chunk, and upserts
   * them into `knowledge_chunk`. Any existing chunks for `documentPath` are
   * removed first.
   *
   * No-op when `embeddingConfig` is null (RAG disabled for this company).
   *
   * @param roleId the owning role, or `null` for a company-shared document
   */
  async ingestDocument(
    companyId: UUID,
    roleId: UUID | null,
    documentPath: string,
    content: string,
    embeddingConfig: LlmConfig | null | undefined,
  ): Promise<void> {
    if (!embeddingConfig) return;

    await this.removeDocument(roleId, documentPath);

    const chunks = splitIntoChunks(content);
    if (chunks.length === 0) return;

    this.logger.log(
      `Indexing ${chunks.length} chunk(s) for ${documentPath} (role ${roleId})`,
    );

    const vectors = await this.embedding.embedTexts(embeddingConfig, chunks);

    for (let i = 0; i < chunks.length; i++) {
      const saved = await this.chunkRepo.save(
        this.chunkRepo.create({
          companyId,
          roleId,
          documentPath,
          chunkIndex: i,
          content: chunks[i],
        }),
      );
      // Write embedding via raw SQL — pgvector type is invisible to TypeORM
      await this.dataSource.query(
        `UPDATE "knowledge_chunk" SET embedding = $1::vector WHERE id = $2`,
        [pgvector.toSql(vectors[i]), saved.id],
      );
    }

    this.logger.log(`Indexed ${chunks.length} chunk(s) for ${documentPath}`);
  }

  /**
   * Deletes all chunks for a document from the knowledge base.
   * Safe to call when no chunks exist (no-op).
   *
   * @param roleId the owning role, or `null` for a company-shared document
   */
  async removeDocument(
    roleId: UUID | null,
    documentPath: string,
  ): Promise<void> {
    await this.chunkRepo.delete({
      roleId: roleId ?? IsNull(),
      documentPath,
    });
  }
}

/**
 * Splits markdown content into chunks of at most {@link MAX_CHUNK_CHARS} characters.
 * Splits on paragraph boundaries (double newlines) first, then on sentence
 * boundaries when a paragraph is still too large.
 */
function splitIntoChunks(text: string): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    if (current.length + para.length + 2 <= MAX_CHUNK_CHARS) {
      current = current ? `${current}\n\n${para}` : para;
    } else {
      if (current) chunks.push(current);
      // Para itself may exceed the limit — split on sentences
      if (para.length <= MAX_CHUNK_CHARS) {
        current = para;
      } else {
        const sentences = para.match(/[^.!?]+[.!?]+/g) ?? [para];
        current = '';
        for (const sentence of sentences) {
          if (current.length + sentence.length + 1 <= MAX_CHUNK_CHARS) {
            current = current ? `${current} ${sentence}` : sentence;
          } else {
            if (current) chunks.push(current);
            current = sentence.slice(0, MAX_CHUNK_CHARS);
          }
        }
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}
