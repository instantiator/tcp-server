import { Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { checkEmbeddingDimension } from '@lcp/shared';

/**
 * Logs a warning on startup if the actual embedding dimension in the database
 * doesn't match `EMBEDDING_DIMENSION`. The {@link DynamicEmbeddingDimension}
 * migration should have already applied any needed change; this is a safety
 * net that catches silent migration failures or manual env-file edits.
 */
export class EmbeddingDimensionCheck implements OnModuleInit {
  private readonly logger = new Logger(EmbeddingDimensionCheck.name);

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    const check = await checkEmbeddingDimension(this.dataSource);

    if (check.actualDimension === null) {
      this.logger.log(
        `Embedding dimension check skipped — knowledge_chunk table not found (dimension: ${check.configuredDimension})`,
      );
      return;
    }

    if (check.migrationNeeded) {
      this.logger.warn(
        `Embedding dimension mismatch: configured ${check.configuredDimension} vs actual ${check.actualDimension}. ` +
          'The DynamicEmbeddingDimension migration should have resolved this — check migration logs.',
      );
    } else {
      this.logger.log(`Embedding dimension OK: ${check.configuredDimension}`);
    }
  }
}
