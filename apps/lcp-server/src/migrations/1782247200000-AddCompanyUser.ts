import { MigrationInterface, QueryRunner } from 'typeorm';

/** Creates the `company_user` table for per-company human user membership. */
export class AddCompanyUser1782247200000 implements MigrationInterface {
  name = 'AddCompanyUser1782247200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "company_user" (
        "id"               uuid      NOT NULL DEFAULT uuid_generate_v4(),
        "companyId"        uuid      NOT NULL,
        "identifier"       varchar   NOT NULL,
        "name"             varchar,
        "memberType"       varchar   NOT NULL,
        "roles"            jsonb     NOT NULL DEFAULT '[]',
        "knowledgeDomains" jsonb     NOT NULL DEFAULT '[]',
        "createdAt"        TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_company_user" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_company_user_company_identifier" ON "company_user" ("companyId", "identifier")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_company_user_company" ON "company_user" ("companyId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "company_user"`);
  }
}
