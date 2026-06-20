import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Allows LLM configuration to be inherited from the company level.
 *
 * - Adds `llmDefault` (nullable JSONB) to `lcp_company`; a non-null value
 *   serves as the fallback for roles that have no `llmConfig` of their own.
 * - Makes `llmConfig` on `lcp_role` nullable so roles can omit it when
 *   relying on the company default.
 */
export class CompanyLlmDefault1750000000002 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "lcp_company" ADD COLUMN IF NOT EXISTS "llmDefault" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_role" ALTER COLUMN "llmConfig" DROP NOT NULL`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Back-fill NULLs with a sentinel before restoring NOT NULL
    await queryRunner.query(
      `UPDATE "lcp_role"
       SET "llmConfig" = '{"provider":"unknown","model":"unknown"}'::jsonb
       WHERE "llmConfig" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_role" ALTER COLUMN "llmConfig" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_company" DROP COLUMN "llmDefault"`,
    );
  }
}
