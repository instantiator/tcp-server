import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds foreign keys the schema was missing from `conversation`,
 * `conversation_message`, `knowledge_chunk`, `episodic_memory`,
 * `company_user`, and `pending_consultation` back to `lcp_company`/
 * `lcp_role`/`lcp_agent`/`conversation` — part of the internal-consistency
 * pass (`docs/prompts/009.2 - internal consistency plan.md`), and a
 * prerequisite for the CLI's `delete-company`/`delete-role` verbs: without
 * these, deleting a company or role would silently orphan rows in all of
 * these tables instead of cascading.
 *
 * `pending_consultation.companyId`/`callingAgentId`/`consultationAgentId`
 * were also typed `varchar` instead of `uuid` (unlike every other FK column
 * in the schema) — fixed here first so the FK constraints below can
 * reference `lcp_company.id`/`lcp_agent.id` (both `uuid`) directly.
 *
 * Assumes existing rows already have valid referential integrity (every
 * `companyId`/`roleId`/etc. actually points to a live parent row) — if not,
 * `ADD CONSTRAINT` below will fail and the orphaned rows need cleanup first.
 */
export class AddMissingCompanyRoleForeignKeys1783357408218 implements MigrationInterface {
  name = 'AddMissingCompanyRoleForeignKeys1783357408218';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pending_consultation" ALTER COLUMN "companyId" TYPE uuid USING "companyId"::uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_consultation" ALTER COLUMN "callingAgentId" TYPE uuid USING "callingAgentId"::uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_consultation" ALTER COLUMN "consultationAgentId" TYPE uuid USING "consultationAgentId"::uuid`,
    );

    await queryRunner.query(
      `ALTER TABLE "conversation" ADD CONSTRAINT "FK_conversation_company" FOREIGN KEY ("companyId") REFERENCES "lcp_company"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" ADD CONSTRAINT "FK_conversation_role" FOREIGN KEY ("roleId") REFERENCES "lcp_role"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_message" ADD CONSTRAINT "FK_conversation_message_conversation" FOREIGN KEY ("conversationId") REFERENCES "conversation"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "knowledge_chunk" ADD CONSTRAINT "FK_knowledge_chunk_company" FOREIGN KEY ("companyId") REFERENCES "lcp_company"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "knowledge_chunk" ADD CONSTRAINT "FK_knowledge_chunk_role" FOREIGN KEY ("roleId") REFERENCES "lcp_role"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "episodic_memory" ADD CONSTRAINT "FK_episodic_memory_company" FOREIGN KEY ("companyId") REFERENCES "lcp_company"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "episodic_memory" ADD CONSTRAINT "FK_episodic_memory_role" FOREIGN KEY ("roleId") REFERENCES "lcp_role"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "company_user" ADD CONSTRAINT "FK_company_user_company" FOREIGN KEY ("companyId") REFERENCES "lcp_company"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_consultation" ADD CONSTRAINT "FK_pending_consultation_company" FOREIGN KEY ("companyId") REFERENCES "lcp_company"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_consultation" ADD CONSTRAINT "FK_pending_consultation_calling_agent" FOREIGN KEY ("callingAgentId") REFERENCES "lcp_agent"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_consultation" ADD CONSTRAINT "FK_pending_consultation_consultation_agent" FOREIGN KEY ("consultationAgentId") REFERENCES "lcp_agent"("id") ON DELETE CASCADE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pending_consultation" DROP CONSTRAINT "FK_pending_consultation_consultation_agent"`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_consultation" DROP CONSTRAINT "FK_pending_consultation_calling_agent"`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_consultation" DROP CONSTRAINT "FK_pending_consultation_company"`,
    );
    await queryRunner.query(
      `ALTER TABLE "company_user" DROP CONSTRAINT "FK_company_user_company"`,
    );
    await queryRunner.query(
      `ALTER TABLE "episodic_memory" DROP CONSTRAINT "FK_episodic_memory_role"`,
    );
    await queryRunner.query(
      `ALTER TABLE "episodic_memory" DROP CONSTRAINT "FK_episodic_memory_company"`,
    );
    await queryRunner.query(
      `ALTER TABLE "knowledge_chunk" DROP CONSTRAINT "FK_knowledge_chunk_role"`,
    );
    await queryRunner.query(
      `ALTER TABLE "knowledge_chunk" DROP CONSTRAINT "FK_knowledge_chunk_company"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_message" DROP CONSTRAINT "FK_conversation_message_conversation"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" DROP CONSTRAINT "FK_conversation_role"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" DROP CONSTRAINT "FK_conversation_company"`,
    );

    await queryRunner.query(
      `ALTER TABLE "pending_consultation" ALTER COLUMN "consultationAgentId" TYPE varchar USING "consultationAgentId"::varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_consultation" ALTER COLUMN "callingAgentId" TYPE varchar USING "callingAgentId"::varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_consultation" ALTER COLUMN "companyId" TYPE varchar USING "companyId"::varchar`,
    );
  }
}
