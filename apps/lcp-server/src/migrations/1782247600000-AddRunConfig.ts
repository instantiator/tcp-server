import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds optional `runConfig` (JSONB, nullable) to both `lcp_role` and `lcp_company`.
 *
 * Stores per-role and per-company agent-loop resource overrides (e.g.
 * `maxIterations`, `timeoutMs`). When set, these values take precedence over
 * the environment variable and code defaults in the precedence order:
 * role → company → env → default.
 */
export class AddRunConfig1782247600000 implements MigrationInterface {
  name = 'AddRunConfig1782247600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "lcp_role" ADD COLUMN IF NOT EXISTS "runConfig" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_company" ADD COLUMN IF NOT EXISTS "runConfig" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "lcp_role" DROP COLUMN IF EXISTS "runConfig"`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_company" DROP COLUMN IF EXISTS "runConfig"`,
    );
  }
}
