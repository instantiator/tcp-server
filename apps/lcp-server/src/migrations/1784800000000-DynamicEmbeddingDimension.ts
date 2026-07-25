import { MigrationInterface, QueryRunner } from 'typeorm';
// Imported by relative path, not the `@lcp/shared` alias: this migration is
// loaded by the e2e tier's Jest globalSetup (via migrations-list.ts), where
// neither Jest's moduleNameMapper nor tsconfig `paths` are applied, so the
// alias would fail to resolve. See test/e2e/global-setup.ts for the same
// constraint.
import { DEFAULT_EMBEDDING_DIMENSION } from '../../../../libs/lcp-shared/src/config/defaults';

/**
 * Dynamic embedding-dimension migration — reads `EMBEDDING_DIMENSION` from the
 * environment and adjusts the vector column width on `knowledge_chunk` and
 * `episodic_memory` only when the actual dimension differs from the target.
 *
 * Unlike {@link ChangeEmbeddingDimension1784600000000} which hardcodes 768,
 * this migration is idempotent: re-running it after the dimension already
 * matches is a no-op.  This lets the `set-embedding-model` script and the
 * setup wizard change dimensions post-deployment by simply updating
 * `EMBEDDING_DIMENSION` in the env file — the next startup applies the change.
 *
 * Existing embeddings cannot be converted between dimensions, so affected
 * scopes need re-indexing afterwards (see `KnowledgeReindexService` or the
 * `reindex-knowledge` CLI verb).
 */
export class DynamicEmbeddingDimension1784800000000 implements MigrationInterface {
  name = 'DynamicEmbeddingDimension1784800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const targetDimension = this.readTargetDimension();
    const actualDimension = await this.readActualDimension(queryRunner);

    if (actualDimension === targetDimension) {
      return;
    }

    await this.applyDimension(queryRunner, targetDimension);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const targetDimension = this.readTargetDimension();
    const actualDimension = await this.readActualDimension(queryRunner);

    if (actualDimension === targetDimension) {
      return;
    }

    await this.applyDimension(queryRunner, targetDimension);
  }

  private readTargetDimension(): number {
    const raw = process.env.EMBEDDING_DIMENSION;
    if (!raw) return DEFAULT_EMBEDDING_DIMENSION;
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed < 1) return DEFAULT_EMBEDDING_DIMENSION;
    return parsed;
  }

  private async readActualDimension(
    queryRunner: QueryRunner,
  ): Promise<number | null> {
    try {
      const rows = (await queryRunner.query(`
          SELECT atttypmod
          FROM pg_attribute
          WHERE attrelid = 'knowledge_chunk'::regclass
            AND attname = 'embedding'
        `)) as Array<{ atttypmod: number | null }>;
      if (rows.length === 0 || !rows[0].atttypmod) return null;
      return rows[0].atttypmod - 8;
    } catch {
      return null;
    }
  }

  private async applyDimension(
    queryRunner: QueryRunner,
    dimension: number,
  ): Promise<void> {
    for (const table of ['knowledge_chunk', 'episodic_memory']) {
      await queryRunner.query(`DROP INDEX IF EXISTS "IDX_${table}_embedding"`);
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN embedding`);
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN embedding vector(${dimension})`,
      );
      await queryRunner.query(
        `CREATE INDEX "IDX_${table}_embedding" ON "${table}" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`,
      );
    }
  }
}
