import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `lcp_task` table (see {@link LcpTask}) — task-orchestration
 * part 3 (`docs/prompts/010.2.3`). `materials`/`expected`/`completed` are
 * `simple-json` columns (stored as `text`) for cross-DB compatibility with
 * the SQLite unit-test path; only `LcpArtifact[]` shapes are ever written.
 *
 * Written by hand (ignore `migration:generate` phantom drift) and registered
 * by hand in `apps/lcp-server/src/app.module.ts`.
 */
export class AddLcpTask1784050000000 implements MigrationInterface {
  name = 'AddLcpTask1784050000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "lcp_task" (
        "id"            uuid      NOT NULL DEFAULT uuid_generate_v4(),
        "companyId"     uuid      NOT NULL,
        "request"       text      NOT NULL,
        "plannerRoleId" uuid,
        "status"        varchar   NOT NULL DEFAULT 'ready',
        "materials"     text      NOT NULL DEFAULT '[]',
        "expected"      text      NOT NULL DEFAULT '[]',
        "completed"     text,
        "failureReason" text,
        "createdAt"     TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt"     TIMESTAMP NOT NULL DEFAULT now(),
        "version"       integer   NOT NULL DEFAULT 1,
        CONSTRAINT "PK_lcp_task" PRIMARY KEY ("id"),
        CONSTRAINT "FK_lcp_task_company" FOREIGN KEY ("companyId") REFERENCES "lcp_company"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_lcp_task_planner_role" FOREIGN KEY ("plannerRoleId") REFERENCES "lcp_role"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_lcp_task_company" ON "lcp_task" ("companyId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_lcp_task_company"`);
    await queryRunner.query(`DROP TABLE "lcp_task"`);
  }
}
