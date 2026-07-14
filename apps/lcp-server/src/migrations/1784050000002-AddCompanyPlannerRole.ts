import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `plannerRoleId` (nullable FK → `lcp_role`, `ON DELETE SET NULL`) to
 * `lcp_company` — the company-wide default planner role, used by
 * {@link LcpTask.plannerRole} when a task does not specify its own.
 *
 * Written by hand (ignore `migration:generate` phantom drift) and registered
 * by hand in `apps/lcp-server/src/app.module.ts`.
 */
export class AddCompanyPlannerRole1784050000002 implements MigrationInterface {
  name = 'AddCompanyPlannerRole1784050000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "lcp_company" ADD COLUMN "plannerRoleId" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_company" ADD CONSTRAINT "FK_lcp_company_planner_role" FOREIGN KEY ("plannerRoleId") REFERENCES "lcp_role"("id") ON DELETE SET NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "lcp_company" DROP CONSTRAINT "FK_lcp_company_planner_role"`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_company" DROP COLUMN "plannerRoleId"`,
    );
  }
}
