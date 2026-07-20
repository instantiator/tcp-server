import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `lcp_assignment.parentAssignmentId` (see {@link LcpAssignment.parentAssignmentId})
 * — the assignment whose agent spawned this one (e.g. a consultation) — and
 * `audit_event.assignmentId` (see {@link AuditEvent.assignmentId}), a
 * denormalized copy of the producing agent's assignment at write time,
 * mirroring the existing `agentId`/`role` denormalization precedent
 * (`docs/prompts/010.3.2` §5).
 *
 * Written by hand (ignore `migration:generate` phantom drift) and registered
 * by hand in `apps/lcp-server/src/app.module.ts`.
 */
export class AddAssignmentParentAndAuditAssignmentId1784200000000 implements MigrationInterface {
  name = 'AddAssignmentParentAndAuditAssignmentId1784200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "lcp_assignment" ADD COLUMN "parentAssignmentId" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_assignment" ADD CONSTRAINT "FK_lcp_assignment_parent_assignment" FOREIGN KEY ("parentAssignmentId") REFERENCES "lcp_assignment"("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_lcp_assignment_parent" ON "lcp_assignment" ("parentAssignmentId")`,
    );

    await queryRunner.query(
      `ALTER TABLE "audit_event" ADD COLUMN "assignmentId" varchar`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_event_company_assignment_timestamp" ON "audit_event" ("companyId", "assignmentId", "timestamp")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_audit_event_company_assignment_timestamp"`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_event" DROP COLUMN "assignmentId"`,
    );

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_lcp_assignment_parent"`);
    await queryRunner.query(
      `ALTER TABLE "lcp_assignment" DROP CONSTRAINT "FK_lcp_assignment_parent_assignment"`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_assignment" DROP COLUMN "parentAssignmentId"`,
    );
  }
}
