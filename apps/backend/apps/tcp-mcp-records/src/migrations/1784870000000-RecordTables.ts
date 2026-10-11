import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the structured-records tables: one `record_table` row per agent
 * table, its rows as JSONB in `record`, and `record_key`, whose primary key is
 * what makes a table's primary and unique keys unique — even across two
 * concurrent inserts — without any per-table DDL.
 *
 * The records database may be tcp-server's or a separate one
 * (`RECORDS_DATABASE_URL`). The company foreign keys are added only when
 * `tcp_company` exists here; a separate database relies on tcp-server's
 * company-delete call instead. So in a shared database tcp-server must have
 * migrated first, which is why the records server starts after it.
 */
export class RecordTables1784870000000 implements MigrationInterface {
  name = 'RecordTables1784870000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "record_table" (
        "id"               uuid              NOT NULL DEFAULT gen_random_uuid(),
        "companyId"        uuid              NOT NULL,
        "name"             character varying NOT NULL,
        "purpose"          text              NOT NULL,
        "schema"           jsonb             NOT NULL,
        "primaryKey"       jsonb             NOT NULL,
        "uniqueKeys"       jsonb             NOT NULL DEFAULT '[]',
        "createdByAgentId" uuid,
        "createdAt"        TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt"        TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_record_table" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_record_table_company_name" UNIQUE ("companyId", "name")
      )`);
    await queryRunner.query(`
      CREATE TABLE "record" (
        "id"        uuid    NOT NULL DEFAULT gen_random_uuid(),
        "tableId"   uuid    NOT NULL,
        "companyId" uuid    NOT NULL,
        "data"      jsonb   NOT NULL,
        "version"   integer NOT NULL DEFAULT 1,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_record" PRIMARY KEY ("id"),
        CONSTRAINT "FK_record_table" FOREIGN KEY ("tableId")
          REFERENCES "record_table"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_record_table_created" ON "record" ("tableId", "createdAt")`,
    );
    await queryRunner.query(`
      CREATE TABLE "record_key" (
        "tableId"  uuid              NOT NULL,
        "keyName"  character varying NOT NULL,
        "keyValue" text              NOT NULL,
        "recordId" uuid              NOT NULL,
        CONSTRAINT "PK_record_key" PRIMARY KEY ("tableId", "keyName", "keyValue"),
        CONSTRAINT "FK_record_key_table" FOREIGN KEY ("tableId")
          REFERENCES "record_table"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_record_key_record" FOREIGN KEY ("recordId")
          REFERENCES "record"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_record_key_record" ON "record_key" ("recordId")`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('tcp_company') IS NOT NULL THEN
          ALTER TABLE "record_table" ADD CONSTRAINT "FK_record_table_company"
            FOREIGN KEY ("companyId") REFERENCES "tcp_company"("id") ON DELETE CASCADE;
          ALTER TABLE "record" ADD CONSTRAINT "FK_record_company"
            FOREIGN KEY ("companyId") REFERENCES "tcp_company"("id") ON DELETE CASCADE;
        END IF;
      END $$`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "record_key"`);
    await queryRunner.query(`DROP TABLE "record"`);
    await queryRunner.query(`DROP TABLE "record_table"`);
  }
}
