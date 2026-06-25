import type { UUID } from 'crypto';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A single agent-authored memory entry stored for later recall.
 * The embedding vector is stored in a `vector(1536)` column managed via raw SQL
 * (pgvector extension) — not mapped by TypeORM.
 */
@Entity()
@Index(['companyId', 'roleId'])
export class EpisodicMemory {
  /**
   * Auto-generated primary key.
   * @format uuid
   */
  @PrimaryGeneratedColumn('uuid')
  id!: UUID;

  /**
   * The company that owns this memory.
   * @format uuid
   */
  @Column({ type: 'varchar' })
  companyId!: UUID;

  /**
   * The role whose episodic memory this belongs to.
   * @format uuid
   */
  @Column({ type: 'varchar' })
  roleId!: UUID;

  /**
   * The agent that recorded this memory (nullable — may be system-generated).
   * @format uuid
   */
  @Column({ type: 'varchar', nullable: true })
  agentId!: UUID | null;

  /** Raw text content of the memory. */
  @Column({ type: 'text' })
  content!: string;

  /** Optional classification tags for filtering. */
  @Column({ type: 'jsonb', nullable: true })
  tags!: string[] | null;

  /** When this memory was created. */
  @CreateDateColumn()
  createdAt!: Date;

  // NOTE: The `embedding vector(1536)` column exists in the database (added by migration
  // AddEpisodicMemory) but is intentionally absent here — all vector operations use raw SQL.
}
