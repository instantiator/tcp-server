import { Module } from '@nestjs/common';
import { MinioService } from './minio.service';

/**
 * Provides {@link MinioService} for object storage operations against MinIO.
 * Reads `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, and
 * `MINIO_BUCKET_PREFIX` from the global config on startup.
 */
@Module({
  providers: [MinioService],
  exports: [MinioService],
})
export class MinioModule {}
