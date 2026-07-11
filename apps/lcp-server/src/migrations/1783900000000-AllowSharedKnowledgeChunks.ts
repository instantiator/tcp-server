import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Allows {@link KnowledgeChunk} rows to represent company-wide (shared)
 * knowledge, as part of the knowledge-folder restructure
 * (`docs/prompts/010.2.1 - task orchestration: knowledge folders and
 * knowledge API.md`): `roleId` becomes nullable, with `null` meaning "chunk
 * indexed from `knowledge/shared/`" rather than a specific role's folder.
 *
 * Existing chunks reference the old name-based knowledge paths
 * (`{company}/knowledge/{role_name}/...`), which no longer match the
 * slug-based paths (`{company}/knowledge/{role_slug}/...`) the storage layer
 * now writes and reads. Re-indexing in place isn't possible without the
 * original source documents, so this destructively truncates the table —
 * explicitly authorised by the plan — rather than leaving stale,
 * unreachable chunks behind. Knowledge documents must be re-uploaded after
 * this migration runs (see `docs/shared-storage.md`).
 *
 * A `(companyId, documentPath)` index is added alongside the existing
 * `(companyId, roleId)` and `(roleId, documentPath)` indexes so shared-scope
 * document lookups (`roleId IS NULL`) stay indexed too.
 */
export class AllowSharedKnowledgeChunks1783900000000 implements MigrationInterface {
  name = 'AllowSharedKnowledgeChunks1783900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`TRUNCATE TABLE "knowledge_chunk"`);
    await queryRunner.query(
      `ALTER TABLE "knowledge_chunk" ALTER COLUMN "roleId" DROP NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_knowledge_chunk_company_document" ON "knowledge_chunk" ("companyId", "documentPath")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_knowledge_chunk_company_document"`,
    );
    await queryRunner.query(`TRUNCATE TABLE "knowledge_chunk"`);
    await queryRunner.query(
      `ALTER TABLE "knowledge_chunk" ALTER COLUMN "roleId" SET NOT NULL`,
    );
  }
}
