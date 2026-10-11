import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `mcpServerToggles` to companies and roles: which MCP servers are
 * switched on or off for that company's agents, or that role's. Null means
 * no preference, so every existing company and role keeps every server.
 */
export class McpServerToggles1784880000000 implements MigrationInterface {
  name = 'McpServerToggles1784880000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tcp_company" ADD COLUMN "mcpServerToggles" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "tcp_role" ADD COLUMN "mcpServerToggles" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tcp_role" DROP COLUMN "mcpServerToggles"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tcp_company" DROP COLUMN "mcpServerToggles"`,
    );
  }
}
