import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `conversation.repliesDeliveredAt`, marking a reply as already handed to
 * the agent that was waiting on it.
 *
 * A resuming agent used to gather its replies by comparing each conversation's
 * `createdAt` against the agent's `pausedAt` — but `createdAt` is stamped by
 * the database's clock and `pausedAt` by the application's, and the two writes
 * are milliseconds apart. When the database clock lagged, the reply fell
 * outside the window and the agent resumed knowing nothing about the question
 * it had asked. This column replaces that comparison with a fact.
 *
 * Existing rows are left null, which reads as "not yet delivered". A closed
 * conversation from before this column can therefore be re-delivered once, to
 * an agent still paused on it — the safe direction, and the agent's own history
 * already carries the exchange.
 *
 * `status` could not carry this instead: `ConversationService.list` exposes it
 * as a public filter, so a `consumed` state would hide delivered replies from
 * anyone listing closed conversations.
 */
export class ConversationRepliesDelivered1784820000000 implements MigrationInterface {
  name = 'ConversationRepliesDelivered1784820000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversation" ADD COLUMN "repliesDeliveredAt" TIMESTAMPTZ`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversation" DROP COLUMN "repliesDeliveredAt"`,
    );
  }
}
