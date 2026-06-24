import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the {@link LcpCompany.embeddingConfig} JSONB column.
 * When set, this config is used by {@link EmbeddingService} to generate
 * and query embeddings for RAG retrieval.
 */
export class AddCompanyEmbeddingConfig1782246974102 implements MigrationInterface {
  name = 'AddCompanyEmbeddingConfig1782246974102';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "lcp_company" ADD "embeddingConfig" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "lcp_company" DROP COLUMN "embeddingConfig"`,
    );
  }
}
