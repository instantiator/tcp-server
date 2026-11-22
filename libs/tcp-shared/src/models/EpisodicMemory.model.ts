import type { UUID } from '../uuid';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One thing a role remembers, written by an agent (`remember`) or a person
 * (the role's Memories tab), and recalled by semantic similarity.
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

  /** When this memory was last changed. */
  @UpdateDateColumn()
  updatedAt!: Date;

  /** Goes up by one on every edit, so an open table can tell a row changed. */
  @Column({ default: 1 })
  version!: number;

  // The `embedding` column (pgvector, sized by `EMBEDDING_DIMENSION`) is left
  // unmapped on purpose: every vector read and write is raw SQL.
}
