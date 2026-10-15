import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Data protection for record tables (001.04): a retention rule per table,
 * and each company's do-not-store list, kept in the records database so the
 * records server can check every write against it without a network call.
 *
 * `normalised` is the entry as matching compares it (see
 * `normaliseDoNotStore`); its uniqueness stops the same entry being listed
 * twice in different case or spacing.
 */
export class DataProtection1784910000000 implements MigrationInterface {
  name = 'DataProtection1784910000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "record_table" ADD COLUMN "retention" jsonb`,
    );
    await queryRunner.query(`
      CREATE TABLE "record_do_not_store" (
        "id"          uuid              NOT NULL DEFAULT gen_random_uuid(),
        "companyId"   uuid              NOT NULL,
        "value"       text              NOT NULL,
        "normalised"  text              NOT NULL,
        "note"        text,
        "addedByRole" character varying NOT NULL,
        "addedById"   character varying,
        "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_record_do_not_store" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_record_do_not_store_value" UNIQUE ("companyId", "normalised")
      )`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('tcp_company') IS NOT NULL THEN
          ALTER TABLE "record_do_not_store" ADD CONSTRAINT "FK_record_do_not_store_company"
            FOREIGN KEY ("companyId") REFERENCES "tcp_company"("id") ON DELETE CASCADE;
        END IF;
      END $$`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "record_do_not_store"`);
    await queryRunner.query(
      `ALTER TABLE "record_table" DROP COLUMN "retention"`,
    );
  }
}
