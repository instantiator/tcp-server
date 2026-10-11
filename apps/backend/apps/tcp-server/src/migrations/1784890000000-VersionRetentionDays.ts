import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `versionRetentionDays` to companies: how long MinIO keeps that
 * company's old file versions. Null means the app-wide default, so every
 * existing company keeps the default.
 */
export class VersionRetentionDays1784890000000 implements MigrationInterface {
  name = 'VersionRetentionDays1784890000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tcp_company" ADD COLUMN "versionRetentionDays" integer`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tcp_company" DROP COLUMN "versionRetentionDays"`,
    );
  }
}
