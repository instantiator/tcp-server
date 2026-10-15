import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `failureCode` to assignments and tasks: the machine-readable reason
 * beside the plain-language `failureReason`. Existing failures keep a null
 * code, as only their text was ever saved.
 */
export class FailureCode1784900000000 implements MigrationInterface {
  name = 'FailureCode1784900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['tcp_assignment', 'tcp_task']) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN "failureCode" character varying`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['tcp_assignment', 'tcp_task']) {
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP COLUMN "failureCode"`,
      );
    }
  }
}
