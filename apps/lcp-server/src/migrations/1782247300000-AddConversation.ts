import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `conversation` and `conversation_message` tables for the human-in-the-loop flow,
 * and adds `queryIndex` to `lcp_role` for slug generation.
 */
export class AddConversation1782247300000 implements MigrationInterface {
  name = 'AddConversation1782247300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "lcp_role" ADD COLUMN "queryIndex" integer NOT NULL DEFAULT 0`,
    );

    await queryRunner.query(`
      CREATE TABLE "conversation" (
        "id"                   uuid      NOT NULL DEFAULT uuid_generate_v4(),
        "slug"                 varchar   NOT NULL,
        "companyId"            uuid      NOT NULL,
        "roleName"             varchar   NOT NULL,
        "roleId"               uuid,
        "agentId"              uuid,
        "question"             text      NOT NULL,
        "context"              text,
        "status"               varchar   NOT NULL DEFAULT 'awaiting_user',
        "routedToIdentifiers"  jsonb     NOT NULL DEFAULT '[]',
        "createdAt"            TIMESTAMP NOT NULL DEFAULT now(),
        "closedAt"             TIMESTAMPTZ,
        CONSTRAINT "PK_conversation" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_conversation_slug" UNIQUE ("slug")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_conversation_company_status" ON "conversation" ("companyId", "status")`,
    );

    await queryRunner.query(`
      CREATE TABLE "conversation_message" (
        "id"               uuid      NOT NULL DEFAULT uuid_generate_v4(),
        "conversationId"   uuid      NOT NULL,
        "author"           varchar   NOT NULL,
        "authorIdentifier" varchar,
        "content"          text      NOT NULL,
        "timestamp"        TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_conversation_message" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_conversation_message_conversation" ON "conversation_message" ("conversationId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "conversation_message"`);
    await queryRunner.query(`DROP TABLE "conversation"`);
    await queryRunner.query(`ALTER TABLE "lcp_role" DROP COLUMN "queryIndex"`);
  }
}
