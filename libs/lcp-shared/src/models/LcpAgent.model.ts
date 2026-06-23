import type { UUID } from 'crypto';
import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { LcpCompany } from './LcpCompany.model';
import { LcpRole } from './LcpRole.model';

/** Lifecycle states for an agent instance. */
export enum AgentStatus {
  /** Created but no job has been dispatched yet. */
  Idle = 'idle',

  /** A job is actively being processed by lcp-agent. */
  Running = 'running',

  /** Suspended, awaiting user input or a consultation response. */
  Paused = 'paused',

  /** The agent loop finished and produced validated output. */
  Completed = 'completed',

  /** The loop encountered an unrecoverable error or exceeded resource limits. */
  Failed = 'failed',
}

/**
 * A running instance of an {@link LcpRole} within an {@link LcpCompany}.
 * Each agent has a LangGraph `thread_id` (stored as {@link LcpAgent.threadId}) that links it
 * to its checkpoint in the PostgreSQL checkpoint store, enabling resumability.
 */
@Entity()
export class LcpAgent {
  /**
   * Auto-generated primary key. Also used as the LangGraph `thread_id`.
   * @format uuid
   */
  @PrimaryGeneratedColumn('uuid')
  id!: UUID;

  /** The company this agent belongs to. */
  @ManyToOne(() => LcpCompany, { nullable: false, onDelete: 'CASCADE' })
  company!: LcpCompany;

  /**
   * Foreign key for the owning {@link LcpCompany}.
   * @format uuid
   */
  @Column()
  companyId!: UUID;

  /** The role template this agent runs as. */
  @ManyToOne(() => LcpRole, { nullable: false, onDelete: 'CASCADE' })
  role!: LcpRole;

  /**
   * Foreign key for the {@link LcpRole} this agent is an instance of.
   * @format uuid
   */
  @Column()
  roleId!: UUID;

  /** Current lifecycle state of this agent. */
  @Column({ type: 'varchar', default: AgentStatus.Idle })
  status!: AgentStatus;

  /**
   * LangGraph checkpoint thread_id. Set to the agent's own UUID on first run.
   * Null until the first BullMQ job is dispatched.
   * @format uuid
   */
  @Column({ nullable: true, type: 'varchar' })
  threadId!: string | null;

  /**
   * The task prompt supplied when the agent was started.
   * @minLength 1
   */
  @Column({ type: 'text' })
  initialPrompt!: string;

  /** Timestamp when this agent record was created. */
  @CreateDateColumn()
  createdAt!: Date;

  /** Timestamp of the last status or field update. */
  @UpdateDateColumn()
  updatedAt!: Date;
}
