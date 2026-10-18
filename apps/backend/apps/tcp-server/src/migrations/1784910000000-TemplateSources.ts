import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `template_source`: the places the company template gallery reads
 * from, beyond the built-in templates.
 */
export class TemplateSources1784910000000 implements MigrationInterface {
  name = 'TemplateSources1784910000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "template_source" (
        "id"        uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name"      character varying NOT NULL,
        "location"  character varying NOT NULL,
        "origin"    character varying NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_template_source" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_template_source_location" UNIQUE ("location")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "template_source"`);
  }
}
