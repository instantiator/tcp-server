import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the non-nullable `assignmentId` FK to `lcp_agent` (see {@link LcpAgent})
 * — task-orchestration part 4 (`docs/prompts/010.2.4`). Every agent now carries
 * an assignment (orphan for non-task work); the agent's mode is its
 * assignment's mode.
 *
 * DESTRUCTIVE (authorised): a non-nullable FK cannot be backfilled for existing
 * agents that have no assignment, so this first DELETEs every `lcp_agent` row.
 * That cascades to rows referencing those agents — conversations
 * (`conversation.agentId`), pending consultations, and audit events — and
 * `SET NULL`s `lcp_assignment.agentId` on any assignment that pointed at a
 * deleted agent. There is no data to preserve at this stage of development.
 *
 * Written by hand (ignore `migration:generate` phantom drift) and registered
 * by hand in `apps/lcp-server/src/app.module.ts`.
 */
export class AddAgentAssignment1784050000003 implements MigrationInterface {
  name = 'AddAgentAssignment1784050000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Non-nullable FK cannot be backfilled — clear the table first (cascades).
    await queryRunner.query(`DELETE FROM "lcp_agent"`);
    await queryRunner.query(
      `ALTER TABLE "lcp_agent" ADD COLUMN "assignmentId" uuid NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_agent" ADD CONSTRAINT "FK_lcp_agent_assignment" FOREIGN KEY ("assignmentId") REFERENCES "lcp_assignment"("id") ON DELETE CASCADE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "lcp_agent" DROP CONSTRAINT "FK_lcp_agent_assignment"`,
    );
    await queryRunner.query(
      `ALTER TABLE "lcp_agent" DROP COLUMN "assignmentId"`,
    );
  }
}
