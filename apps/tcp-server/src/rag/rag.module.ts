import {
  KnowledgeChunk,
  KnowledgeRetrievalService,
  KnowledgeIndexState,
  TcpCompany,
  TcpRole,
} from '@tcp/shared';
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from '../storage/storage.module';
import { EmbeddingService } from './embedding.service';
import { KnowledgeReindexService } from './knowledge-reindex.service';
import { RagIndexService } from './rag-index.service';

/**
 * Provides RAG (Retrieval-Augmented Generation) services for tcp-server.
 *
 * - {@link EmbeddingService} — generates embeddings using the company's config
 * - {@link RagIndexService} — ingests and removes OKF knowledge-base documents
 * - {@link KnowledgeRetrievalService} — retrieves relevant chunks for a query
 * - {@link KnowledgeReindexService} — keeps embeddings in sync with storage
 *   (write hook + reconciliation poller) and owns the reindex queue/worker
 *
 * {@link StorageModule} is imported via `forwardRef` because the storage
 * adapter injects {@link KnowledgeReindexService} for its write hook, forming
 * a deliberate cycle between the two modules.
 *
 * Import this module in any NestJS module that needs to index or query the
 * knowledge base.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      KnowledgeChunk,
      KnowledgeIndexState,
      TcpCompany,
      TcpRole,
    ]),
    forwardRef(() => StorageModule),
  ],
  providers: [
    EmbeddingService,
    RagIndexService,
    KnowledgeRetrievalService,
    KnowledgeReindexService,
  ],
  exports: [
    EmbeddingService,
    RagIndexService,
    KnowledgeRetrievalService,
    KnowledgeReindexService,
  ],
})
export class RagModule {}
