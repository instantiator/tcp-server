import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `lastError`/`lastErrorAt` to `knowledge_index_state` (see
 * {@link KnowledgeIndexState}) — set when a scope's rebuild job throws (e.g.
 * the embedding endpoint is unreachable), cleared on the next successful
 * rebuild. Surfaced via `get-knowledge-index-status` and as an
 * `X-Lcp-Warnings` warning on the other knowledge endpoints (see
 * `KnowledgeService.embeddingWarnings`).
 *
 * Postgres-only (SQLite tests use `synchronize`). Written by hand (ignore
 * `migration:generate` phantom drift) and registered by hand in
 * `apps/lcp-server/src/migrations-list.ts`.
 */
export class AddKnowledgeIndexStateLastError1784700000000 implements MigrationInterface {
  name = 'AddKnowledgeIndexStateLastError1784700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "knowledge_index_state" ADD COLUMN "lastError" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "knowledge_index_state" ADD COLUMN "lastErrorAt" TIMESTAMP`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "knowledge_index_state" DROP COLUMN "lastErrorAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "knowledge_index_state" DROP COLUMN "lastError"`,
    );
  }
}
