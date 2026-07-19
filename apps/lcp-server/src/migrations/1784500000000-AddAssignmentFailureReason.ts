import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `lcp_assignment.failureReason` (see {@link LcpAssignment.failureReason}),
 * the assignment-level mirror of {@link LcpTask.failureReason} — a
 * human-readable reason set whenever an assignment is failed (QA exhaustion,
 * agent run failure, etc).
 *
 * Postgres-only (SQLite tests use `synchronize`). Written by hand (ignore
 * `migration:generate` phantom drift) and registered by hand in
 * `apps/lcp-server/src/app.module.ts`.
 */
export class AddAssignmentFailureReason1784500000000 implements MigrationInterface {
  name = 'AddAssignmentFailureReason1784500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "lcp_assignment" ADD COLUMN "failureReason" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "lcp_assignment" DROP COLUMN "failureReason"`,
    );
  }
}
