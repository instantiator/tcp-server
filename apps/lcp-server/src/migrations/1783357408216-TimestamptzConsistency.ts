import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Standardizes all `Date`-typed columns to `timestamptz`, as part of the
 * internal-consistency pass (`docs/prompts/009.2 - internal consistency
 * plan.md`).
 *
 * Several of these columns were `timestamptz` in the migration that first
 * created them, then silently reverted to naive `timestamp` by a later,
 * unrelated-looking migration (`1782144931792-AddCompanyDescription.ts`) —
 * most likely an auto-generated migration reconciling drift back to what
 * the entity decorators imply by default on Postgres, since TypeORM's
 * `@CreateDateColumn()`/`@Column()` on a `Date` field are deliberately left
 * untyped in this codebase (see `docs/database.md` "Timestamp storage
 * convention" and `[[feedback-typeorm-cross-db-dates]]`): an explicit
 * `type: 'timestamptz'` on the entity would break the SQLite driver used
 * for tests. So this fix is Postgres-schema-only, done by hand here, never
 * by adding an explicit type back onto the entity — `npm run
 * migration:generate` will continue to report these columns as "drift"
 * indefinitely as a result, which is expected (see `scripts/check-migrations.sh`).
 *
 * Assumes the Postgres session/database timezone is UTC — this repo's
 * `docker-compose.yml` sets no `TZ` override for the `postgres` service, so
 * the official image's default (UTC) applies. Run `SHOW timezone;` against
 * the target database before applying this migration in an environment
 * where that assumption might not hold; adjust the `AT TIME ZONE` literal
 * below if it does not.
 */
export class TimestamptzConsistency1783357408216 implements MigrationInterface {
  name = 'TimestamptzConsistency1783357408216';

  private readonly columns: Array<[table: string, column: string]> = [
    ['audit_event', 'timestamp'],
    ['company_user', 'createdAt'],
    ['conversation', 'createdAt'],
    ['conversation_message', 'timestamp'],
    ['episodic_memory', 'createdAt'],
    ['knowledge_chunk', 'createdAt'],
    ['lcp_agent', 'createdAt'],
    ['lcp_agent', 'updatedAt'],
    ['lcp_agent', 'pausedAt'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [table, column] of this.columns) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE timestamptz USING "${column}" AT TIME ZONE 'UTC'`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [table, column] of this.columns) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE timestamp USING "${column}" AT TIME ZONE 'UTC'`,
      );
    }
  }
}
