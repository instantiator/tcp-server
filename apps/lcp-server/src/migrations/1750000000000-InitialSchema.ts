import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Initial schema migration. Enables the pgvector extension and creates
 * the {@link LcpCompany} table.
 */
export class InitialSchema1750000000000 implements MigrationInterface {
  /** Applies the migration: enables pgvector and creates the `lcp_company` table. */
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "lcp_company" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "slug" character varying NOT NULL,
        "name" character varying NOT NULL,
        CONSTRAINT "UQ_lcp_company_slug" UNIQUE ("slug"),
        CONSTRAINT "PK_lcp_company" PRIMARY KEY ("id")
      )
    `);
  }

  /** Reverts the migration: drops the `lcp_company` table. */
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "lcp_company"');
  }
}
