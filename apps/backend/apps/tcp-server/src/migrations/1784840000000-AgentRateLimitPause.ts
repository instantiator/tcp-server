import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `tcp_agent.resumeAfter` and `tcp_agent.rateLimitRetries`, so an agent
 * a provider rate-limited can be paused rather than failed, and resumed at
 * the provider's hinted time or on a doubling backoff.
 */
export class AgentRateLimitPause1784840000000 implements MigrationInterface {
  name = 'AgentRateLimitPause1784840000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tcp_agent" ADD COLUMN "resumeAfter" TIMESTAMPTZ`,
    );
    await queryRunner.query(
      `ALTER TABLE "tcp_agent" ADD COLUMN "rateLimitRetries" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tcp_agent" DROP COLUMN "rateLimitRetries"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tcp_agent" DROP COLUMN "resumeAfter"`,
    );
  }
}
