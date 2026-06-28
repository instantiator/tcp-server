import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `storageChanges` (TEXT, nullable) to `lcp_agent`.
 * Stores a JSON-encoded snapshot of files created/modified/deleted/moved
 * during the agent loop run, used by `complete_task` file validation.
 */
export class AddAgentStorageChanges1782247500000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE lcp_agent ADD COLUMN IF NOT EXISTS "storageChanges" TEXT`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE lcp_agent DROP COLUMN IF EXISTS "storageChanges"`,
    );
  }
}
