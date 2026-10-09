import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `notification.companyId` and `taskId`, so a task failing or being
 * paused by a shutdown can raise a notice its company's members see, with a
 * link to the task. Existing rows stay application-wide.
 */
export class TaskNotifications1784860000000 implements MigrationInterface {
  name = 'TaskNotifications1784860000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notification" ADD COLUMN "companyId" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification" ADD COLUMN "taskId" character varying`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notification_companyId" ON "notification" ("companyId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_notification_companyId"`);
    await queryRunner.query(`ALTER TABLE "notification" DROP COLUMN "taskId"`);
    await queryRunner.query(
      `ALTER TABLE "notification" DROP COLUMN "companyId"`,
    );
  }
}
