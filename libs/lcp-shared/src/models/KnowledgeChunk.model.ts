import type { UUID } from 'crypto';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A single chunk of text extracted from an OKF knowledge-base document and
 * stored for RAG retrieval. The corresponding embedding vector is stored
 * directly in PostgreSQL as a `vector(768)` column (pgvector extension)
 * and is not mapped by TypeORM — all vector reads and writes use raw SQL.
 *
 * Chunks are scoped to a {@link LcpCompany}, and optionally to a
 * {@link LcpRole} within it — `roleId` is `null` for chunks from the
 * company-wide `knowledge/shared/` folder (see storage-keys.ts).
 * All chunks for a given `documentPath` are replaced atomically on re-index.
 */
@Entity()
@Index(['companyId', 'roleId'])
@Index(['roleId', 'documentPath'])
@Index(['companyId', 'documentPath'])
export class KnowledgeChunk {
  /**
   * Auto-generated primary key.
   * @format uuid
   */
  @PrimaryGeneratedColumn('uuid')
  id!: UUID;

  /**
   * The company that owns this chunk.
   * @format uuid
   */
  @Column({ type: 'varchar' })
  companyId!: UUID;

  /**
   * The role whose knowledge base this chunk belongs to. `null` for chunks
   * indexed from the company-wide `knowledge/shared/` folder.
   * @format uuid
   */
  @Column({ type: 'varchar', nullable: true })
  roleId!: UUID | null;

  /**
   * MinIO path of the OKF source document this chunk was extracted from.
   * Used to identify all chunks belonging to one document for deletion/re-index.
   * @minLength 1
   */
  @Column({ type: 'text' })
  documentPath!: string;

  /** Zero-based position of this chunk within its source document. */
  @Column()
  chunkIndex!: number;

  /**
   * Raw text content of this chunk.
   * @minLength 1
   */
  @Column({ type: 'text' })
  content!: string;

  /** When this chunk was created. */
  @CreateDateColumn()
  createdAt!: Date;

  // NOTE: The `embedding vector(768)` column exists in the database (added by migration
  // AddKnowledgeChunkEmbedding) but is intentionally absent here. All vector operations
  // use DataSource.query() with explicit SQL so the pgvector type never touches the ORM.
}
