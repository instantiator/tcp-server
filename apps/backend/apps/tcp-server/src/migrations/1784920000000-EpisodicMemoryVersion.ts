import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `version` and `updatedAt` to `episodic_memory`, so people and agents
 * can edit a memory and an open memory table can tell it changed (002.06).
 */
export class EpisodicMemoryVersion1784920000000 implements MigrationInterface {
  name = 'EpisodicMemoryVersion1784920000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "episodic_memory"
        ADD COLUMN "version"   integer     NOT NULL DEFAULT 1,
        ADD COLUMN "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    `);
    await queryRunner.query(
      `UPDATE "episodic_memory" SET "updatedAt" = "createdAt"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "episodic_memory"
        DROP COLUMN "updatedAt",
        DROP COLUMN "version"
    `);
  }
}
