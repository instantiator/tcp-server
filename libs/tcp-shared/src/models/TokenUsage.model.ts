import type { UUID } from '../uuid';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One LLM call's recorded token usage. Insert-only: a row is written once and
 * never updated or deleted, so spend history survives the task or agent it
 * references being removed later — for the same reason it carries no foreign
 * keys. Per-provider/per-task totals are computed by the reader (`GROUP BY`),
 * not maintained here.
 */
@Entity()
@Index(['provider', 'createdAt'])
@Index(['companyId', 'createdAt'])
export class TokenUsage {
  /** @format uuid */
  @PrimaryGeneratedColumn('uuid')
  id!: UUID;

  /** The company the LLM call was made on behalf of. */
  @Column({ type: 'varchar' })
  companyId!: UUID;

  /** The task running at the time, if any — chats and orphan agents have none. */
  @Column({ nullable: true, type: 'varchar' })
  taskId?: UUID;

  /** The agent that made the call, if any. */
  @Column({ nullable: true, type: 'varchar' })
  agentId?: UUID;

  /** Catalogue provider id the call was billed against. */
  @Column({ type: 'varchar' })
  provider!: string;

  /** The model identifier used for the call. */
  @Column({ type: 'varchar' })
  model!: string;

  /** Prompt tokens consumed. */
  @Column({ type: 'int' })
  inputTokens!: number;

  /** Completion tokens produced. */
  @Column({ type: 'int' })
  outputTokens!: number;

  /** When this row was recorded. */
  @CreateDateColumn()
  createdAt!: Date;
}
