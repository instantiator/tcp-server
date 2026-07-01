import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `pausedAt` (TIMESTAMP, nullable) to `lcp_agent`.
 * Set when the agent transitions to Paused; cleared on resume. Scopes which
 * consultation/conversation responses belong to the current pause episode.
 */
export class AddAgentPausedAt1782831650682 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE lcp_agent ADD COLUMN IF NOT EXISTS "pausedAt" TIMESTAMP`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE lcp_agent DROP COLUMN IF EXISTS "pausedAt"`,
    );
  }
}
