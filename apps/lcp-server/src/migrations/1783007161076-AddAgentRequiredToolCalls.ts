import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `requiredToolCalls` (TEXT, nullable, simple-json) to `lcp_agent`.
 * Tool names that must have been invoked before the agent loop may end;
 * null means the default (`['complete_task']`), an empty array opts out.
 */
export class AddAgentRequiredToolCalls1783007161076 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE lcp_agent ADD COLUMN IF NOT EXISTS "requiredToolCalls" TEXT`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE lcp_agent DROP COLUMN IF EXISTS "requiredToolCalls"`,
    );
  }
}
