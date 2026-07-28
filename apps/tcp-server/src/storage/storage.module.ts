import { TcpCompany } from '@tcp/shared';
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { RagModule } from '../rag/rag.module';
import { MinioStorageAdapter } from './minio-storage.adapter';
import { StorageSideEffects } from './storage-side-effects.service';
import { StorageService } from './storage.service';

/**
 * Provides {@link StorageService}, backed today by {@link MinioStorageAdapter}.
 * Reads `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, and
 * `MINIO_BUCKET_PREFIX` from the global config on startup. Imports
 * {@link AuditModule} and the `TcpCompany` repository so writes can record
 * a properly attributed audit event.
 *
 * {@link RagModule} is imported via `forwardRef` because the adapter's write
 * hook calls `KnowledgeReindexService.bumpByKey` to keep RAG embeddings in
 * sync — a deliberate cycle between the two modules.
 */
@Module({
  imports: [
    AuditModule,
    TypeOrmModule.forFeature([TcpCompany]),
    forwardRef(() => RagModule),
  ],
  providers: [
    MinioStorageAdapter,
    StorageSideEffects,
    { provide: StorageService, useExisting: MinioStorageAdapter },
  ],
  exports: [StorageService, MinioStorageAdapter],
})
export class StorageModule {}
