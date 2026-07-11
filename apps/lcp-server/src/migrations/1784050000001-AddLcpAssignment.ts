import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `lcp_assignment` table (see {@link LcpAssignment}) —
 * task-orchestration part 3 (`docs/prompts/010.2.3`). A task's plan is its
 * implement-mode assignments ordered by `orderIndex`; there is no separate
 * plan table. `taskId` is nullable — null means an "orphan" assignment
 * (a plain conversation/consultation outside any task).
 * `materials`/`expected`/`prepared`/`approved` are `simple-json` columns
 * (stored as `text`) for cross-DB compatibility with the SQLite unit-test
 * path; only `LcpArtifact[]` shapes are ever written.
 *
 * Written by hand (ignore `migration:generate` phantom drift) and registered
 * by hand in `apps/lcp-server/src/app.module.ts`.
 */
export class AddLcpAssignment1784050000001 implements MigrationInterface {
  name = 'AddLcpAssignment1784050000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "lcp_assignment" (
        "id"                 uuid      NOT NULL DEFAULT uuid_generate_v4(),
        "taskId"             uuid,
        "companyId"          uuid      NOT NULL,
        "mode"               varchar   NOT NULL DEFAULT 'implement',
        "orderIndex"         integer,
        "prompt"             text      NOT NULL,
        "roleId"             uuid      NOT NULL,
        "status"             varchar   NOT NULL DEFAULT 'ready',
        "agentId"            uuid,
        "targetAssignmentId" uuid,
        "materials"          text      NOT NULL DEFAULT '[]',
        "expected"           text      NOT NULL DEFAULT '[]',
        "prepared"           text      NOT NULL DEFAULT '[]',
        "approved"           text      NOT NULL DEFAULT '[]',
        "summary"            text,
        "qaStatus"           varchar,
        "qaFeedback"         text,
        "qaAttempts"         integer   NOT NULL DEFAULT 0,
        "createdAt"          TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt"          TIMESTAMP NOT NULL DEFAULT now(),
        "version"            integer   NOT NULL DEFAULT 1,
        CONSTRAINT "PK_lcp_assignment" PRIMARY KEY ("id"),
        CONSTRAINT "FK_lcp_assignment_task" FOREIGN KEY ("taskId") REFERENCES "lcp_task"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_lcp_assignment_company" FOREIGN KEY ("companyId") REFERENCES "lcp_company"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_lcp_assignment_role" FOREIGN KEY ("roleId") REFERENCES "lcp_role"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_lcp_assignment_agent" FOREIGN KEY ("agentId") REFERENCES "lcp_agent"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_lcp_assignment_target_assignment" FOREIGN KEY ("targetAssignmentId") REFERENCES "lcp_assignment"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_lcp_assignment_task_order" ON "lcp_assignment" ("taskId", "orderIndex")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_lcp_assignment_company" ON "lcp_assignment" ("companyId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_lcp_assignment_agent" ON "lcp_assignment" ("agentId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_lcp_assignment_agent"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_lcp_assignment_company"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_lcp_assignment_task_order"`,
    );
    await queryRunner.query(`DROP TABLE "lcp_assignment"`);
  }
}
