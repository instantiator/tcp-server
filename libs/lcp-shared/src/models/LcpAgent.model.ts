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
import { VersionedEntity } from './VersionedEntity';

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
export class LcpAgent extends VersionedEntity {
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

  /**
   * Final output produced by the agent on completion.
   * Set via the `complete_task` MCP tool, or as a fallback from the last AI
   * message when the loop exits naturally.
   */
  @Column({ type: 'text', nullable: true })
  output!: string | null;

  /**
   * Storage changes accumulated by the agent loop during the current (or last) run.
   * Updated incrementally by lcp-agent as storage MCP tool calls complete.
   * Used by lcp-mcp-interactions to include context in `complete_task` error messages.
   *
   * Uses `simple-json` (stored as TEXT) for cross-DB compatibility with SQLite unit tests.
   */
  @Column({ type: 'simple-json', nullable: true })
  storageChanges?: {
    created: string[];
    modified: string[];
    deleted: string[];
    moved: { from: string; to: string }[];
  } | null;

  /**
   * Tool names (unprefixed, e.g. `complete_task`) that must have been invoked
   * successfully before the agent loop may end. Null means the default
   * (`['complete_task']`); an empty array disables enforcement.
   *
   * Uses `simple-json` (stored as TEXT) for cross-DB compatibility with SQLite unit tests.
   */
  @Column({ type: 'simple-json', nullable: true })
  requiredToolCalls?: string[] | null;

  /** Timestamp of the last status or field update. */
  @UpdateDateColumn()
  updatedAt!: Date;

  /**
   * Set when this agent transitions to {@link AgentStatus.Paused}; cleared on
   * resume. Scopes which consultation/conversation responses belong to the
   * current pause episode when aggregating a resume message.
   */
  @Column({ nullable: true })
  pausedAt?: Date;
}
