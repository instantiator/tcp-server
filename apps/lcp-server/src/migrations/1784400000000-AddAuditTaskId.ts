import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `audit_event.taskId` (see {@link AuditEvent.taskId}), a denormalised
 * task scope so task history can be read by a single `(companyId, taskId,
 * timestamp)` query — including agent-less orchestrator rows that the old
 * assignments→agents join missed (`docs/prompts/010.5.1` §A).
 *
 * Backfills existing rows: agent rows via the assignment join, orchestrator
 * rows (agentId null) from their jsonb payload (which already carried
 * `taskId`/`assignmentId` for legacy-row compatibility).
 *
 * Postgres-only (SQLite tests use `synchronize`). Written by hand (ignore
 * `migration:generate` phantom drift) and registered by hand in
 * `apps/lcp-server/src/app.module.ts`.
 */
export class AddAuditTaskId1784400000000 implements MigrationInterface {
  name = 'AddAuditTaskId1784400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "audit_event" ADD COLUMN "taskId" varchar`,
    );

    // Agent rows: derive the task from the producing agent's assignment.
    // `audit_event.assignmentId` is varchar while `lcp_assignment.id`/`taskId`
    // are uuid, so both sides of the join and the assignment need casting.
    await queryRunner.query(
      `UPDATE "audit_event" ae SET "taskId" = a."taskId"::varchar FROM "lcp_assignment" a WHERE ae."assignmentId" = a."id"::varchar AND a."taskId" IS NOT NULL`,
    );

    // Orchestrator rows (agentId null): recover ids from the jsonb payload.
    await queryRunner.query(
      `UPDATE "audit_event" SET "taskId" = payload->>'taskId' WHERE "agentId" IS NULL AND payload ? 'taskId'`,
    );
    await queryRunner.query(
      `UPDATE "audit_event" SET "assignmentId" = payload->>'assignmentId' WHERE "assignmentId" IS NULL AND payload ? 'assignmentId'`,
    );

    await queryRunner.query(
      `CREATE INDEX "IDX_audit_event_company_task_timestamp" ON "audit_event" ("companyId", "taskId", "timestamp")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_audit_event_company_task_timestamp"`,
    );
    await queryRunner.query(`ALTER TABLE "audit_event" DROP COLUMN "taskId"`);
  }
}
