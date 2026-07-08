import { LcpCompany } from '@lcp/shared';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { MinioStorageAdapter } from './minio-storage.adapter';
import { StorageService } from './storage.service';

/**
 * Provides {@link StorageService}, backed today by {@link MinioStorageAdapter}.
 * Reads `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, and
 * `MINIO_BUCKET_PREFIX` from the global config on startup. Imports
 * {@link AuditModule} and the `LcpCompany` repository so writes can record
 * a properly attributed audit event.
 */
@Module({
  imports: [AuditModule, TypeOrmModule.forFeature([LcpCompany])],
  providers: [
    MinioStorageAdapter,
    { provide: StorageService, useExisting: MinioStorageAdapter },
  ],
  exports: [StorageService, MinioStorageAdapter],
})
export class StorageModule {}
