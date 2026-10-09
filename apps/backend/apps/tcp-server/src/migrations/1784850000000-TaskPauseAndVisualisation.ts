import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `tcp_task.pausedAt` and `pausedBy`, so a user can pause a task, and
 * `visualisationClosedAt`, so a finished task's office room stays until a
 * user closes it. Tasks already finished are closed, so the office doesn't
 * reopen a room for every past task.
 */
export class TaskPauseAndVisualisation1784850000000 implements MigrationInterface {
  name = 'TaskPauseAndVisualisation1784850000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tcp_task" ADD COLUMN "pausedAt" TIMESTAMPTZ`,
    );
    await queryRunner.query(
      `ALTER TABLE "tcp_task" ADD COLUMN "pausedBy" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "tcp_task" ADD COLUMN "visualisationClosedAt" TIMESTAMPTZ`,
    );
    await queryRunner.query(
      `UPDATE "tcp_task" SET "visualisationClosedAt" = now() WHERE "status" IN ('succeeded', 'failed', 'cancelled')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tcp_task" DROP COLUMN "visualisationClosedAt"`,
    );
    await queryRunner.query(`ALTER TABLE "tcp_task" DROP COLUMN "pausedBy"`);
    await queryRunner.query(`ALTER TABLE "tcp_task" DROP COLUMN "pausedAt"`);
  }
}
