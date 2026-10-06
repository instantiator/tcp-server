import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds spend-tracking schema (`docs/prompts/phase 04 - utility/000.02.01.plan
 * - spend tracking.md`, stage 1):
 *
 * - `token_usage`: one insert-only row per recorded LLM call. No foreign keys
 *   — usage must outlive the task/agent rows it references.
 * - `notification`: the application-wide notice table (003.03 extends it).
 * - `spend_cap_state`: one row per provider, the single source of truth for
 *   cap evaluation (stage 4 reads and writes it; stage 1 only creates it).
 * - `tcp_task.spendCapExempt`: set by an explicit start/resume so the (future)
 *   spend-cap gate never re-pauses that task's agents mid-turn.
 */
export class SpendTracking1784830000000 implements MigrationInterface {
  name = 'SpendTracking1784830000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "token_usage" (
        "id"           uuid              NOT NULL DEFAULT uuid_generate_v4(),
        "companyId"    uuid              NOT NULL,
        "taskId"       uuid,
        "agentId"      uuid,
        "provider"     character varying NOT NULL,
        "model"        character varying NOT NULL,
        "inputTokens"  integer           NOT NULL,
        "outputTokens" integer           NOT NULL,
        "createdAt"    TIMESTAMPTZ       NOT NULL DEFAULT now(),
        CONSTRAINT "PK_token_usage" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "notification" (
        "id"          uuid              NOT NULL DEFAULT uuid_generate_v4(),
        "severity"    character varying NOT NULL,
        "kind"        character varying NOT NULL,
        "message"     character varying NOT NULL,
        "params"      jsonb,
        "dedupeKey"   character varying,
        "createdAt"   TIMESTAMPTZ       NOT NULL DEFAULT now(),
        "dismissedAt" TIMESTAMPTZ,
        CONSTRAINT "PK_notification" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_notification_dedupe_key" UNIQUE ("dedupeKey")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "spend_cap_state" (
        "provider"     character varying NOT NULL,
        "windowStarts" jsonb             NOT NULL DEFAULT '{}',
        "reachedUntil" TIMESTAMPTZ,
        "action"       character varying,
        "dismissal"    character varying NOT NULL DEFAULT 'none',
        "updatedAt"    TIMESTAMPTZ       NOT NULL DEFAULT now(),
        CONSTRAINT "PK_spend_cap_state" PRIMARY KEY ("provider")
      )
    `);

    await queryRunner.query(
      `ALTER TABLE "tcp_task" ADD "spendCapExempt" boolean NOT NULL DEFAULT false`,
    );

    await queryRunner.query(
      `CREATE INDEX "IDX_token_usage_provider_created" ON "token_usage" ("provider", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_token_usage_company_created" ON "token_usage" ("companyId", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tcp_task" DROP COLUMN "spendCapExempt"`,
    );
    for (const table of ['spend_cap_state', 'notification', 'token_usage']) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
  }
}
