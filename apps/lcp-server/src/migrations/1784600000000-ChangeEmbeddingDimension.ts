import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Changes the `embedding` column on `knowledge_chunk` and `episodic_memory`
 * from `vector(1536)` to `vector(768)`.
 *
 * 1536 (matching OpenAI's `text-embedding-ada-002`/`text-embedding-3-small`)
 * turned out to be an unrepresentative default: most local/open embedding
 * models served via LM Studio or similar (`nomic-embed-text`, `bge-base`,
 * `gte-base`, ...) are natively 768-dimensional, and pgvector's `vector(N)`
 * column width is fixed and shared across every company — there is no
 * per-company flexibility without a much larger redesign.
 *
 * There is no way to convert a vector between dimensions, so this
 * necessarily discards any existing embeddings; affected scopes need
 * re-indexing afterwards (see `KnowledgeReindexService.bumpCompany` / the
 * `reindex-knowledge` CLI verb).
 */
export class ChangeEmbeddingDimension1784600000000 implements MigrationInterface {
  name = 'ChangeEmbeddingDimension1784600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_knowledge_chunk_embedding"`,
    );
    await queryRunner.query(
      `ALTER TABLE "knowledge_chunk" DROP COLUMN embedding`,
    );
    await queryRunner.query(
      `ALTER TABLE "knowledge_chunk" ADD COLUMN embedding vector(768)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_knowledge_chunk_embedding" ON "knowledge_chunk" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`,
    );

    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_episodic_memory_embedding"`,
    );
    await queryRunner.query(
      `ALTER TABLE "episodic_memory" DROP COLUMN embedding`,
    );
    await queryRunner.query(
      `ALTER TABLE "episodic_memory" ADD COLUMN embedding vector(768)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_episodic_memory_embedding" ON "episodic_memory" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_knowledge_chunk_embedding"`,
    );
    await queryRunner.query(
      `ALTER TABLE "knowledge_chunk" DROP COLUMN embedding`,
    );
    await queryRunner.query(
      `ALTER TABLE "knowledge_chunk" ADD COLUMN embedding vector(1536)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_knowledge_chunk_embedding" ON "knowledge_chunk" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`,
    );

    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_episodic_memory_embedding"`,
    );
    await queryRunner.query(
      `ALTER TABLE "episodic_memory" DROP COLUMN embedding`,
    );
    await queryRunner.query(
      `ALTER TABLE "episodic_memory" ADD COLUMN embedding vector(1536)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_episodic_memory_embedding" ON "episodic_memory" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`,
    );
  }
}
