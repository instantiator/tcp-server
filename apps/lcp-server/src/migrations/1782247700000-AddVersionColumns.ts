import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds an optimistic-concurrency `version` column (integer, default 1) to
 * `lcp_agent`, `conversation`, and `pending_consultation`.
 *
 * TypeORM's `@VersionColumn()` increments this value on every `save()` and
 * throws `OptimisticLockVersionMismatchError` when a stale version is
 * detected, preventing lost updates under concurrent writes. Callers wrap
 * writes in `withOptimisticRetry` to handle the conflict automatically.
 */
export class AddVersionColumns1782247700000 implements MigrationInterface {
  name = 'AddVersionColumns1782247700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "lcp_agent" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_consultation" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "lcp_agent" DROP COLUMN IF EXISTS "version"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" DROP COLUMN IF EXISTS "version"`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_consultation" DROP COLUMN IF EXISTS "version"`,
    );
  }
}
