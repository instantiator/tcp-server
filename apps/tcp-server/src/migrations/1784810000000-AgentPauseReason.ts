import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `tcp_agent.pauseReason`, recording why a paused agent is paused.
 *
 * A shutdown drain pauses agents that have nothing outstanding to wait for,
 * which is otherwise indistinguishable from an agent paused for user input
 * whose reply has already arrived. Existing rows are left null: a pause that
 * predates this column resolves through the consultation/conversation records
 * that were already driving it.
 */
export class AgentPauseReason1784810000000 implements MigrationInterface {
  name = 'AgentPauseReason1784810000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tcp_agent" ADD COLUMN "pauseReason" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tcp_agent" DROP COLUMN "pauseReason"`,
    );
  }
}
