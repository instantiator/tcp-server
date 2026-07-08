import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Aligns {@link LcpCompany} with {@link LcpRole} for LLM/prompt/MCP
 * configuration, as part of the internal-consistency pass
 * (`docs/prompts/009.2 - internal consistency plan.md`):
 *
 * - Renames `llmDefault` to `llmConfig` (data-preserving rename, not
 *   drop+add) so both entities implement the same `WithLlmConfig` shape.
 * - Adds `systemPromptTemplate` (nullable) — a company-wide fallback used
 *   when a role leaves its own blank, before the baked-in default.
 * - Adds `mcpServerList` (jsonb, default `[]`) — additive extra MCP servers
 *   for every role in the company, unioned with the system registry and
 *   each role's own list.
 * - Adds `timezone` (nullable) — IANA name used only for CLI/UI display and
 *   prompt localization; storage and the LLM's UTC time anchor are
 *   unaffected.
 * - Makes `lcp_role.systemPromptTemplate` nullable to match: a role may now
 *   leave it blank and inherit the company's or the baked-in default,
 *   instead of being required to always author one.
 */
export class CompanyLlmConfigAndPromptFields1783357408215 implements MigrationInterface {
  name = 'CompanyLlmConfigAndPromptFields1783357408215';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "lcp_company" RENAME COLUMN "llmDefault" TO "llmConfig"`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_company" ADD COLUMN IF NOT EXISTS "systemPromptTemplate" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_company" ADD COLUMN IF NOT EXISTS "mcpServerList" jsonb NOT NULL DEFAULT '[]'`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_company" ADD COLUMN IF NOT EXISTS "timezone" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_role" ALTER COLUMN "systemPromptTemplate" DROP NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Backfill so the NOT NULL constraint can be restored without failing on
    // rows that took on a null systemPromptTemplate after this migration ran.
    await queryRunner.query(
      `UPDATE "lcp_role" SET "systemPromptTemplate" = '' WHERE "systemPromptTemplate" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_role" ALTER COLUMN "systemPromptTemplate" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_company" DROP COLUMN IF EXISTS "timezone"`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_company" DROP COLUMN IF EXISTS "mcpServerList"`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_company" DROP COLUMN IF EXISTS "systemPromptTemplate"`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_company" RENAME COLUMN "llmConfig" TO "llmDefault"`,
    );
  }
}
