import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `output` column to `lcp_agent` and creates the
 * `pending_consultation` table for the inter-agent pause/resume flow.
 */
export class AddAgentOutputAndConsultation1782247400000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE lcp_agent ADD COLUMN IF NOT EXISTS output TEXT`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS pending_consultation (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "callingAgentId"      VARCHAR NOT NULL,
        "consultationAgentId" VARCHAR NOT NULL,
        "companyId"           VARCHAR NOT NULL,
        status     VARCHAR NOT NULL DEFAULT 'pending',
        result     TEXT,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_pending_consultation_agent
        ON pending_consultation ("consultationAgentId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_pending_consultation_calling
        ON pending_consultation ("callingAgentId", status)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS pending_consultation`);
    await queryRunner.query(
      `ALTER TABLE lcp_agent DROP COLUMN IF EXISTS output`,
    );
  }
}
