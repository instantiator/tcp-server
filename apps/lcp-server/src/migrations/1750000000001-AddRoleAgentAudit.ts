import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the role, agent, and audit-event tables required for the lcp-agent MVP.
 *
 * - `lcp_role`: stores role templates (LLM config, system prompt, etc.)
 * - `lcp_agent`: stores running/historical agent instances; `thread_id` links to LangGraph checkpoints
 * - `audit_events`: time-ordered event log written by lcp-agent during each run
 */
export class AddRoleAgentAudit1750000000001 implements MigrationInterface {
  /** Creates the three new tables with their constraints and indexes. */
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "lcp_role" (
        "id"                    uuid NOT NULL DEFAULT gen_random_uuid(),
        "companyId"             uuid NOT NULL,
        "name"                  character varying NOT NULL,
        "description"           text NOT NULL,
        "llmConfig"             jsonb NOT NULL,
        "systemPromptTemplate"  text NOT NULL,
        "knowledgeDomains"      jsonb NOT NULL DEFAULT '[]',
        "mcpServerList"         jsonb NOT NULL DEFAULT '[]',
        CONSTRAINT "PK_lcp_role" PRIMARY KEY ("id"),
        CONSTRAINT "FK_lcp_role_company"
          FOREIGN KEY ("companyId") REFERENCES "lcp_company"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "lcp_agent" (
        "id"            uuid NOT NULL DEFAULT gen_random_uuid(),
        "companyId"     uuid NOT NULL,
        "roleId"        uuid NOT NULL,
        "status"        character varying NOT NULL DEFAULT 'idle',
        "threadId"      character varying,
        "initialPrompt" text NOT NULL,
        "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_lcp_agent" PRIMARY KEY ("id"),
        CONSTRAINT "FK_lcp_agent_company"
          FOREIGN KEY ("companyId") REFERENCES "lcp_company"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_lcp_agent_role"
          FOREIGN KEY ("roleId") REFERENCES "lcp_role"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "audit_event" (
        "id"        uuid NOT NULL DEFAULT gen_random_uuid(),
        "timestamp" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "companyId" uuid NOT NULL,
        "role"      character varying NOT NULL,
        "agentId"   uuid,
        "eventType" character varying NOT NULL,
        "payload"   jsonb NOT NULL,
        CONSTRAINT "PK_audit_event" PRIMARY KEY ("id"),
        CONSTRAINT "FK_audit_event_company"
          FOREIGN KEY ("companyId") REFERENCES "lcp_company"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_audit_event_agent"
          FOREIGN KEY ("agentId") REFERENCES "lcp_agent"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_audit_event_company_agent_timestamp"
        ON "audit_event" ("companyId", "agentId", "timestamp")
    `);
  }

  /** Drops all three tables in reverse dependency order. */
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "audit_event"');
    await queryRunner.query('DROP TABLE IF EXISTS "lcp_agent"');
    await queryRunner.query('DROP TABLE IF EXISTS "lcp_role"');
  }
}
