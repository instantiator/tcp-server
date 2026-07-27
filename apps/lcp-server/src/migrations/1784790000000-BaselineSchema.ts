import { MigrationInterface, QueryRunner } from 'typeorm';
// Imported by relative path, not the `@lcp/shared` alias: this migration is
// loaded by the e2e tier's Jest globalSetup (via migrations-list.ts), where
// neither Jest's moduleNameMapper nor tsconfig `paths` are applied, so the
// alias would fail to resolve. See test/e2e/global-setup.ts for the same
// constraint.
import { DEFAULT_EMBEDDING_DIMENSION } from '../../../../libs/lcp-shared/src/config/defaults';

/**
 * Baseline schema — the cumulative result of the 33 incremental migrations
 * that preceded it, squashed into a single `CREATE`-only migration
 * (`docs/prompts/phase 01 - service/011.1.1 - comprehensive rename to TCP.md`).
 *
 * The squash discards the upgrade path from every intermediate state: an
 * existing database cannot be migrated onto this baseline and must be
 * recreated. Applying it to a database that already has these tables fails
 * loudly on the first `CREATE TABLE`, which is the intended outcome.
 *
 * Schema notes that look accidental and are not — this migration reproduces a
 * fully-migrated database exactly, quirks included:
 *
 * - Timestamp columns are a deliberate mix. Everything the timestamptz
 *   consistency pass covered is `timestamptz`; the tables added afterwards
 *   (`lcp_task`, `lcp_assignment`, `knowledge_index_state`) kept naive
 *   `timestamp`. See `docs/database.md` "Timestamp storage convention".
 * - `id` defaults are a mix of `gen_random_uuid()` and `uuid_generate_v4()`,
 *   following whichever the originating migration used.
 * - `pending_consultation` keeps Postgres-generated constraint names
 *   (`pending_consultation_pkey`) and lowercase index names, because the
 *   migration that created it declared its primary key inline.
 * - `simple-json` columns (`materials`, `expected`, `prepared`, `approved`,
 *   `completed`, `storageChanges`, `requiredToolCalls`) are `text`, so the same
 *   entities work against the SQLite unit-test path.
 *
 * The pgvector `embedding` columns are sized from
 * {@link DEFAULT_EMBEDDING_DIMENSION}; {@link DynamicEmbeddingDimension1784800000000}
 * runs immediately after and resizes them when `EMBEDDING_DIMENSION` differs.
 */
export class BaselineSchema1784790000000 implements MigrationInterface {
  name = 'BaselineSchema1784790000000';

  /** Creates every table, index, and foreign key from empty. */
  public async up(queryRunner: QueryRunner): Promise<void> {
    // `uuid-ossp` is also auto-created by TypeORM's PostgresDriver on connect,
    // but the `uuid_generate_v4()` defaults below should not depend on that.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector`);

    await this.createTables(queryRunner);
    await this.createIndexes(queryRunner);
    await this.createForeignKeys(queryRunner);
  }

  /** Drops every table this migration created, in reverse dependency order. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'pending_consultation',
      'conversation_message',
      'conversation',
      'company_user',
      'knowledge_index_state',
      'knowledge_chunk',
      'episodic_memory',
      'audit_event',
      'lcp_agent',
      'lcp_assignment',
      'lcp_task',
      'lcp_role',
      'lcp_company',
    ]) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
  }

  /**
   * Creates all 13 tables without their foreign keys — `lcp_company` and
   * `lcp_role` reference each other, so no creation order satisfies both.
   */
  private async createTables(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "lcp_company" (
        "id"                     uuid              NOT NULL DEFAULT gen_random_uuid(),
        "slug"                   character varying NOT NULL,
        "name"                   character varying NOT NULL,
        "llmConfig"              jsonb,
        "description"            character varying NOT NULL,
        "companyContext"         text,
        "embeddingConfig"        jsonb,
        "runConfig"              jsonb,
        "systemPromptTemplate"   text,
        "mcpServerList"          jsonb             NOT NULL DEFAULT '[]',
        "timezone"               character varying,
        "plannerRoleId"          uuid,
        "nextTaskShortcodeIndex" integer           NOT NULL DEFAULT 0,
        CONSTRAINT "PK_lcp_company" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_lcp_company_slug" UNIQUE ("slug")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "lcp_role" (
        "id"                   uuid              NOT NULL DEFAULT gen_random_uuid(),
        "companyId"            uuid              NOT NULL,
        "name"                 character varying NOT NULL,
        "description"          text              NOT NULL,
        "llmConfig"            jsonb,
        "systemPromptTemplate" text,
        "knowledgeDomains"     jsonb             NOT NULL DEFAULT '[]',
        "mcpServerList"        jsonb             NOT NULL DEFAULT '[]',
        "rolePrompt"           text,
        "queryIndex"           integer           NOT NULL DEFAULT 0,
        "runConfig"            jsonb,
        "slug"                 character varying NOT NULL,
        CONSTRAINT "PK_lcp_role" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "lcp_task" (
        "id"            uuid              NOT NULL DEFAULT uuid_generate_v4(),
        "companyId"     uuid              NOT NULL,
        "request"       text              NOT NULL,
        "plannerRoleId" uuid,
        "status"        character varying NOT NULL DEFAULT 'ready',
        "materials"     text              NOT NULL DEFAULT '[]',
        "expected"      text              NOT NULL DEFAULT '[]',
        "completed"     text,
        "failureReason" text,
        "createdAt"     TIMESTAMP         NOT NULL DEFAULT now(),
        "updatedAt"     TIMESTAMP         NOT NULL DEFAULT now(),
        "version"       integer           NOT NULL DEFAULT 1,
        "shortcode"     character varying NOT NULL,
        CONSTRAINT "PK_lcp_task" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "lcp_assignment" (
        "id"                 uuid              NOT NULL DEFAULT uuid_generate_v4(),
        "taskId"             uuid,
        "companyId"          uuid              NOT NULL,
        "mode"               character varying NOT NULL DEFAULT 'implement',
        "orderIndex"         integer,
        "prompt"             text              NOT NULL,
        "roleId"             uuid              NOT NULL,
        "status"             character varying NOT NULL DEFAULT 'ready',
        "agentId"            uuid,
        "targetAssignmentId" uuid,
        "materials"          text              NOT NULL DEFAULT '[]',
        "expected"           text              NOT NULL DEFAULT '[]',
        "prepared"           text              NOT NULL DEFAULT '[]',
        "approved"           text              NOT NULL DEFAULT '[]',
        "summary"            text,
        "qaStatus"           character varying,
        "qaFeedback"         text,
        "qaAttempts"         integer           NOT NULL DEFAULT 0,
        "createdAt"          TIMESTAMP         NOT NULL DEFAULT now(),
        "updatedAt"          TIMESTAMP         NOT NULL DEFAULT now(),
        "version"            integer           NOT NULL DEFAULT 1,
        "parentAssignmentId" uuid,
        "shortcode"          character varying,
        "failureReason"      text,
        CONSTRAINT "PK_lcp_assignment" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "lcp_agent" (
        "id"                uuid              NOT NULL DEFAULT gen_random_uuid(),
        "companyId"         uuid              NOT NULL,
        "roleId"            uuid              NOT NULL,
        "status"            character varying NOT NULL DEFAULT 'idle',
        "threadId"          character varying,
        "initialPrompt"     text              NOT NULL,
        "createdAt"         TIMESTAMPTZ       NOT NULL DEFAULT now(),
        "updatedAt"         TIMESTAMPTZ       NOT NULL DEFAULT now(),
        "output"            text,
        "storageChanges"    text,
        "version"           integer           NOT NULL DEFAULT 1,
        "pausedAt"          TIMESTAMPTZ,
        "requiredToolCalls" text,
        "assignmentId"      uuid              NOT NULL,
        CONSTRAINT "PK_lcp_agent" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "audit_event" (
        "id"           uuid              NOT NULL DEFAULT gen_random_uuid(),
        "companyId"    uuid              NOT NULL,
        "role"         character varying NOT NULL,
        "agentId"      uuid,
        "eventType"    character varying NOT NULL,
        "payload"      jsonb             NOT NULL,
        "timestamp"    TIMESTAMPTZ       NOT NULL DEFAULT now(),
        "assignmentId" character varying,
        "taskId"       character varying,
        CONSTRAINT "PK_audit_event" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "episodic_memory" (
        "id"        uuid        NOT NULL DEFAULT uuid_generate_v4(),
        "companyId" uuid        NOT NULL,
        "roleId"    uuid        NOT NULL,
        "agentId"   uuid,
        "content"   text        NOT NULL,
        "tags"      jsonb,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "embedding" vector(${DEFAULT_EMBEDDING_DIMENSION}),
        CONSTRAINT "PK_episodic_memory" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "knowledge_chunk" (
        "id"           uuid        NOT NULL DEFAULT uuid_generate_v4(),
        "companyId"    uuid        NOT NULL,
        "roleId"       uuid,
        "documentPath" text        NOT NULL,
        "chunkIndex"   integer     NOT NULL,
        "content"      text        NOT NULL,
        "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
        "embedding"    vector(${DEFAULT_EMBEDDING_DIMENSION}),
        CONSTRAINT "PK_knowledge_chunk" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "knowledge_index_state" (
        "id"          uuid      NOT NULL DEFAULT uuid_generate_v4(),
        "companyId"   uuid      NOT NULL,
        "roleId"      uuid,
        "generation"  integer   NOT NULL DEFAULT 0,
        "fingerprint" text,
        "updatedAt"   TIMESTAMP NOT NULL DEFAULT now(),
        "lastError"   text,
        "lastErrorAt" TIMESTAMP,
        CONSTRAINT "PK_knowledge_index_state" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "company_user" (
        "id"               uuid              NOT NULL DEFAULT uuid_generate_v4(),
        "companyId"        uuid              NOT NULL,
        "identifier"       character varying NOT NULL,
        "name"             character varying,
        "memberType"       character varying NOT NULL,
        "roles"            jsonb             NOT NULL DEFAULT '[]',
        "knowledgeDomains" jsonb             NOT NULL DEFAULT '[]',
        "createdAt"        TIMESTAMPTZ       NOT NULL DEFAULT now(),
        CONSTRAINT "PK_company_user" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "conversation" (
        "id"                  uuid              NOT NULL DEFAULT uuid_generate_v4(),
        "slug"                character varying NOT NULL,
        "companyId"           uuid              NOT NULL,
        "roleName"            character varying NOT NULL,
        "roleId"              uuid,
        "agentId"             uuid,
        "question"            text              NOT NULL,
        "context"             text,
        "status"              character varying NOT NULL DEFAULT 'awaiting_user',
        "routedToIdentifiers" jsonb             NOT NULL DEFAULT '[]',
        "createdAt"           TIMESTAMPTZ       NOT NULL DEFAULT now(),
        "closedAt"            TIMESTAMPTZ,
        "version"             integer           NOT NULL DEFAULT 1,
        CONSTRAINT "PK_conversation" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_conversation_slug" UNIQUE ("slug")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "conversation_message" (
        "id"               uuid              NOT NULL DEFAULT uuid_generate_v4(),
        "conversationId"   uuid              NOT NULL,
        "author"           character varying NOT NULL,
        "authorIdentifier" character varying,
        "content"          text              NOT NULL,
        "timestamp"        TIMESTAMPTZ       NOT NULL DEFAULT now(),
        CONSTRAINT "PK_conversation_message" PRIMARY KEY ("id")
      )
    `);

    // Primary key declared inline and unnamed, so Postgres names it
    // `pending_consultation_pkey` exactly as the original migration did.
    await queryRunner.query(`
      CREATE TABLE "pending_consultation" (
        "id"                  uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
        "callingAgentId"      uuid              NOT NULL,
        "consultationAgentId" uuid              NOT NULL,
        "companyId"           uuid              NOT NULL,
        "status"              character varying NOT NULL DEFAULT 'pending',
        "result"              text,
        "createdAt"           TIMESTAMPTZ       NOT NULL DEFAULT now(),
        "version"             integer           NOT NULL DEFAULT 1
      )
    `);
  }

  /** Creates every secondary index, including the two IVFFlat vector indexes. */
  private async createIndexes(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_lcp_role_company_slug" ON "lcp_role" ("companyId", "slug")`,
    );

    await queryRunner.query(
      `CREATE INDEX "IDX_lcp_task_company" ON "lcp_task" ("companyId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_lcp_task_company_shortcode" ON "lcp_task" ("companyId", "shortcode")`,
    );

    await queryRunner.query(
      `CREATE INDEX "IDX_lcp_assignment_task_order" ON "lcp_assignment" ("taskId", "orderIndex")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_lcp_assignment_company" ON "lcp_assignment" ("companyId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_lcp_assignment_agent" ON "lcp_assignment" ("agentId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_lcp_assignment_parent" ON "lcp_assignment" ("parentAssignmentId")`,
    );

    await queryRunner.query(
      `CREATE INDEX "IDX_audit_event_company_agent_timestamp" ON "audit_event" ("companyId", "agentId", "timestamp")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_event_company_assignment_timestamp" ON "audit_event" ("companyId", "assignmentId", "timestamp")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_event_company_task_timestamp" ON "audit_event" ("companyId", "taskId", "timestamp")`,
    );

    await queryRunner.query(
      `CREATE INDEX "IDX_episodic_memory_company_role" ON "episodic_memory" ("companyId", "roleId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_episodic_memory_embedding" ON "episodic_memory" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`,
    );

    await queryRunner.query(
      `CREATE INDEX "IDX_knowledge_chunk_company_role" ON "knowledge_chunk" ("companyId", "roleId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_knowledge_chunk_role_document" ON "knowledge_chunk" ("roleId", "documentPath")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_knowledge_chunk_company_document" ON "knowledge_chunk" ("companyId", "documentPath")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_knowledge_chunk_embedding" ON "knowledge_chunk" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`,
    );

    // Partial indexes, not a plain UNIQUE(companyId, roleId): Postgres treats
    // NULL role ids as distinct and would allow duplicate shared-scope rows.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_knowledge_index_state_role" ON "knowledge_index_state" ("companyId", "roleId") WHERE "roleId" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_knowledge_index_state_shared" ON "knowledge_index_state" ("companyId") WHERE "roleId" IS NULL`,
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_company_user_company_identifier" ON "company_user" ("companyId", "identifier")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_company_user_company" ON "company_user" ("companyId")`,
    );

    await queryRunner.query(
      `CREATE INDEX "IDX_conversation_company_status" ON "conversation" ("companyId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_conversation_message_conversation" ON "conversation_message" ("conversationId")`,
    );

    await queryRunner.query(
      `CREATE INDEX "idx_pending_consultation_agent" ON "pending_consultation" ("consultationAgentId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_pending_consultation_calling" ON "pending_consultation" ("callingAgentId", "status")`,
    );
  }

  /** Adds every foreign key, once all referenced tables exist. */
  private async createForeignKeys(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "lcp_company" ADD CONSTRAINT "FK_lcp_company_planner_role" FOREIGN KEY ("plannerRoleId") REFERENCES "lcp_role"("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_role" ADD CONSTRAINT "FK_lcp_role_company" FOREIGN KEY ("companyId") REFERENCES "lcp_company"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_task" ADD CONSTRAINT "FK_lcp_task_company" FOREIGN KEY ("companyId") REFERENCES "lcp_company"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_task" ADD CONSTRAINT "FK_lcp_task_planner_role" FOREIGN KEY ("plannerRoleId") REFERENCES "lcp_role"("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_assignment" ADD CONSTRAINT "FK_lcp_assignment_task" FOREIGN KEY ("taskId") REFERENCES "lcp_task"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_assignment" ADD CONSTRAINT "FK_lcp_assignment_company" FOREIGN KEY ("companyId") REFERENCES "lcp_company"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_assignment" ADD CONSTRAINT "FK_lcp_assignment_role" FOREIGN KEY ("roleId") REFERENCES "lcp_role"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_assignment" ADD CONSTRAINT "FK_lcp_assignment_agent" FOREIGN KEY ("agentId") REFERENCES "lcp_agent"("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_assignment" ADD CONSTRAINT "FK_lcp_assignment_target_assignment" FOREIGN KEY ("targetAssignmentId") REFERENCES "lcp_assignment"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_assignment" ADD CONSTRAINT "FK_lcp_assignment_parent_assignment" FOREIGN KEY ("parentAssignmentId") REFERENCES "lcp_assignment"("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_agent" ADD CONSTRAINT "FK_lcp_agent_company" FOREIGN KEY ("companyId") REFERENCES "lcp_company"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_agent" ADD CONSTRAINT "FK_lcp_agent_role" FOREIGN KEY ("roleId") REFERENCES "lcp_role"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_agent" ADD CONSTRAINT "FK_lcp_agent_assignment" FOREIGN KEY ("assignmentId") REFERENCES "lcp_assignment"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_event" ADD CONSTRAINT "FK_audit_event_company" FOREIGN KEY ("companyId") REFERENCES "lcp_company"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_event" ADD CONSTRAINT "FK_audit_event_agent" FOREIGN KEY ("agentId") REFERENCES "lcp_agent"("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "episodic_memory" ADD CONSTRAINT "FK_episodic_memory_company" FOREIGN KEY ("companyId") REFERENCES "lcp_company"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "episodic_memory" ADD CONSTRAINT "FK_episodic_memory_role" FOREIGN KEY ("roleId") REFERENCES "lcp_role"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "knowledge_chunk" ADD CONSTRAINT "FK_knowledge_chunk_company" FOREIGN KEY ("companyId") REFERENCES "lcp_company"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "knowledge_chunk" ADD CONSTRAINT "FK_knowledge_chunk_role" FOREIGN KEY ("roleId") REFERENCES "lcp_role"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "company_user" ADD CONSTRAINT "FK_company_user_company" FOREIGN KEY ("companyId") REFERENCES "lcp_company"("id") ON DELETE CASCADE`,
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
      `ALTER TABLE "pending_consultation" ADD CONSTRAINT "FK_pending_consultation_company" FOREIGN KEY ("companyId") REFERENCES "lcp_company"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_consultation" ADD CONSTRAINT "FK_pending_consultation_calling_agent" FOREIGN KEY ("callingAgentId") REFERENCES "lcp_agent"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_consultation" ADD CONSTRAINT "FK_pending_consultation_consultation_agent" FOREIGN KEY ("consultationAgentId") REFERENCES "lcp_agent"("id") ON DELETE CASCADE`,
    );
  }
}
