import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds a per-company `shortcode` to {@link LcpTask} (`'000'`, `'001'`, …,
 * generated from the new `lcp_company.nextTaskShortcodeIndex` counter — see
 * `TaskService.create`) and a derived `shortcode` to {@link LcpAssignment}
 * (`{taskShortcode}-{planIndex}-{mode}`, e.g. `000-001-implement`; null for
 * orphan assignments — see `buildAssignmentShortcode`), so both can be
 * addressed by a short identifier in `lcp-cli` instead of only a UUID
 * (`docs/prompts/010.3.3.2` feedback).
 *
 * Existing rows have no shortcode yet: tasks are backfilled per company in
 * `createdAt` order, and `lcp_company.nextTaskShortcodeIndex` is left at the
 * resulting per-company task count so the next created task continues the
 * sequence. Existing assignments are backfilled from their (now-shortcoded)
 * task using the same plan-index rule `buildAssignmentShortcode` encodes —
 * `plan` → 0, `implement` → `orderIndex + 1`, `qa`/`consultee` → their
 * target/parent assignment's plan index — anything else (orphans, or a
 * qa/consultee with no resolvable anchor) is left null.
 *
 * Written by hand (ignore `migration:generate` phantom drift) and registered
 * by hand in `apps/lcp-server/src/app.module.ts`.
 */
export class AddShortcodes1784300000000 implements MigrationInterface {
  name = 'AddShortcodes1784300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "lcp_company" ADD COLUMN "nextTaskShortcodeIndex" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_task" ADD COLUMN "shortcode" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_assignment" ADD COLUMN "shortcode" character varying`,
    );

    const tasks = (await queryRunner.query(
      `SELECT "id", "companyId" FROM "lcp_task" ORDER BY "companyId", "createdAt"`,
    )) as Array<{ id: string; companyId: string }>;

    const nextIndexByCompany = new Map<string, number>();
    const taskShortcodeById = new Map<string, string>();
    for (const task of tasks) {
      const index = nextIndexByCompany.get(task.companyId) ?? 0;
      nextIndexByCompany.set(task.companyId, index + 1);
      const shortcode = String(index).padStart(3, '0');
      taskShortcodeById.set(task.id, shortcode);
      await queryRunner.query(
        `UPDATE "lcp_task" SET "shortcode" = $1 WHERE "id" = $2`,
        [shortcode, task.id],
      );
    }
    for (const [companyId, count] of nextIndexByCompany) {
      await queryRunner.query(
        `UPDATE "lcp_company" SET "nextTaskShortcodeIndex" = $1 WHERE "id" = $2`,
        [count, companyId],
      );
    }

    await queryRunner.query(
      `ALTER TABLE "lcp_task" ALTER COLUMN "shortcode" SET NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_lcp_task_company_shortcode" ON "lcp_task" ("companyId", "shortcode")`,
    );

    const assignments = (await queryRunner.query(
      `SELECT "id", "taskId", "mode", "orderIndex", "targetAssignmentId", "parentAssignmentId"
       FROM "lcp_assignment" WHERE "taskId" IS NOT NULL`,
    )) as Array<{
      id: string;
      taskId: string;
      mode: string;
      orderIndex: number | null;
      targetAssignmentId: string | null;
      parentAssignmentId: string | null;
    }>;
    const byId = new Map(assignments.map((a) => [a.id, a]));

    // Plan/implement plan indices are self-contained; resolve those first so
    // qa/consultee (which anchor to another assignment's plan index) can look
    // them up regardless of row order.
    const planIndexById = new Map<string, number>();
    for (const a of assignments) {
      if (a.mode === 'plan') planIndexById.set(a.id, 0);
      else if (a.mode === 'implement' && a.orderIndex != null) {
        planIndexById.set(a.id, a.orderIndex + 1);
      }
    }
    const resolveAnchorPlanIndex = (
      a: (typeof assignments)[number],
    ): number | undefined => {
      const anchorId = a.targetAssignmentId ?? a.parentAssignmentId;
      const anchor = anchorId ? byId.get(anchorId) : undefined;
      return anchor ? planIndexById.get(anchor.id) : undefined;
    };
    for (const a of assignments) {
      if (planIndexById.has(a.id)) continue;
      const resolved = resolveAnchorPlanIndex(a);
      if (resolved != null) planIndexById.set(a.id, resolved);
    }

    for (const a of assignments) {
      const planIndex = planIndexById.get(a.id);
      const taskShortcode = taskShortcodeById.get(a.taskId);
      if (planIndex == null || !taskShortcode) continue;
      const shortcode = `${taskShortcode}-${String(planIndex).padStart(3, '0')}-${a.mode}`;
      await queryRunner.query(
        `UPDATE "lcp_assignment" SET "shortcode" = $1 WHERE "id" = $2`,
        [shortcode, a.id],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "lcp_assignment" DROP COLUMN "shortcode"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_lcp_task_company_shortcode"`,
    );
    await queryRunner.query(`ALTER TABLE "lcp_task" DROP COLUMN "shortcode"`);
    await queryRunner.query(
      `ALTER TABLE "lcp_company" DROP COLUMN "nextTaskShortcodeIndex"`,
    );
  }
}
