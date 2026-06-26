import { KnowledgeChunk } from '@lcp/shared';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EmbeddingService } from './embedding.service';
import { RagIndexService } from './rag-index.service';
import { RagRetrievalService } from './rag-retrieval.service';

/**
 * Provides RAG (Retrieval-Augmented Generation) services for lcp-server.
 *
 * - {@link EmbeddingService} — generates embeddings using the company's config
 * - {@link RagIndexService} — ingests and removes OKF knowledge-base documents
 * - {@link RagRetrievalService} — retrieves relevant chunks for a query
 *
 * Import this module in any NestJS module that needs to index or query the
 * knowledge base.
 */
@Module({
  imports: [TypeOrmModule.forFeature([KnowledgeChunk])],
  providers: [EmbeddingService, RagIndexService, RagRetrievalService],
  exports: [EmbeddingService, RagIndexService, RagRetrievalService],
})
export class RagModule {}
