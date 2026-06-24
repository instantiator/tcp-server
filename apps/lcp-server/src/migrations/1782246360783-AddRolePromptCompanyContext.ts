import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the {@link LcpRole.rolePrompt} and {@link LcpCompany.companyContext}
 * columns to support the 8-part prompt structure defined in ADR-013.
 *
 * Both columns are nullable so existing rows are unaffected — omitting them
 * preserves the previous behaviour where {@link LcpRole.systemPromptTemplate}
 * alone provides all pre-task context.
 */
export class AddRolePromptCompanyContext1782246360783 implements MigrationInterface {
  name = 'AddRolePromptCompanyContext1782246360783';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "lcp_role" ADD "rolePrompt" text`);
    await queryRunner.query(
      `ALTER TABLE "lcp_company" ADD "companyContext" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "lcp_company" DROP COLUMN "companyContext"`,
    );
    await queryRunner.query(`ALTER TABLE "lcp_role" DROP COLUMN "rolePrompt"`);
  }
}
