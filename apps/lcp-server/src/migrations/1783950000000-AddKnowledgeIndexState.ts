import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `knowledge_index_state` table, which tracks the RAG-indexing
 * state (generation counter + last-indexed fingerprint) of each knowledge
 * scope — a role's `knowledge/{role_slug}/` folder or a company's
 * `knowledge/shared/` folder (`roleId IS NULL`). See
 * {@link KnowledgeIndexState} and
 * `apps/lcp-server/src/rag/knowledge-reindex.service.ts`.
 *
 * Two partial unique indexes enforce one row per scope: a plain
 * `UNIQUE(companyId, roleId)` would treat `NULL` role ids as distinct in
 * Postgres and allow duplicate shared rows. They double as the `ON CONFLICT`
 * targets for the atomic generation-increment upsert.
 *
 * Written by hand (ignore `migration:generate` phantom drift) and registered
 * by hand in `apps/lcp-server/src/app.module.ts`.
 */
export class AddKnowledgeIndexState1783950000000 implements MigrationInterface {
  name = 'AddKnowledgeIndexState1783950000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "knowledge_index_state" (
        "id"          uuid      NOT NULL DEFAULT uuid_generate_v4(),
        "companyId"   uuid      NOT NULL,
        "roleId"      uuid,
        "generation"  integer   NOT NULL DEFAULT 0,
        "fingerprint" text,
        "updatedAt"   TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_knowledge_index_state" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_knowledge_index_state_role" ON "knowledge_index_state" ("companyId", "roleId") WHERE "roleId" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_knowledge_index_state_shared" ON "knowledge_index_state" ("companyId") WHERE "roleId" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_knowledge_index_state_shared"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_knowledge_index_state_role"`,
    );
    await queryRunner.query(`DROP TABLE "knowledge_index_state"`);
  }
}
