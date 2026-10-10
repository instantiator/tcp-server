import type { UUID } from '../uuid';
import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { sanitiseTextColumn } from '../validation/sanitize';
import { TcpAssignment } from './TcpAssignment.model';
import { TcpCompany } from './TcpCompany.model';
import { TcpRole } from './TcpRole.model';
import { VersionedEntity } from './VersionedEntity';

/** Lifecycle states for an agent instance. */
export enum AgentStatus {
  /** Created but no job has been dispatched yet. */
  Idle = 'idle',

  /**
   * A start or resume job is dispatched but hasn't started: it is waiting for
   * a worker, or for a free slot in its model pool or endpoint
   * (`MODEL_CONCURRENCY`). Shown so a wait doesn't look like a hang.
   */
  Queued = 'queued',

  /** A job is actively being processed by tcp-agent. */
  Running = 'running',

  /** Suspended, awaiting user input or a consultation response. */
  Paused = 'paused',

  /** The agent loop finished and produced validated output. */
  Completed = 'completed',

  /** The loop encountered an unrecoverable error or exceeded resource limits. */
  Failed = 'failed',

  /** The agent's task (or assignment) was cancelled; the loop stops on its next status check. */
  Cancelled = 'cancelled',
}

/**
 * Why an agent is currently {@link AgentStatus.Paused}.
 *
 * `user_input` and `consultation` pauses resolve themselves — a reply or a
 * consultation result arrives and the agent is re-dispatched automatically. A
 * `shutdown` pause has nothing outstanding to wait on, so it stays paused
 * until a user resumes it explicitly. A `spend_cap` pause is lifted when the
 * provider's cap resets or is dismissed, or by an explicit task/company resume.
 * A `rate_limited` pause — the provider refused a call — is lifted at
 * {@link TcpAgent.resumeAfter} when auto-resume is on, or by an explicit
 * resume. A `manual` pause — a user paused the agent's task — is lifted only
 * by an explicit resume of that task. A `restart` pause — a restart drain
 * stopped the agent, or startup recovery found it stranded — is lifted by
 * tcp-server's next boot, or by an explicit resume.
 */
export type PauseReason =
  | 'user_input'
  | 'consultation'
  | 'shutdown'
  | 'spend_cap'
  | 'rate_limited'
  | 'manual'
  | 'restart';

/**
 * A running instance of an {@link TcpRole} within an {@link TcpCompany}.
 * Each agent has a LangGraph `thread_id` (stored as {@link TcpAgent.threadId}) that links it
 * to its checkpoint in the PostgreSQL checkpoint store, enabling resumability.
 */
@Entity()
export class TcpAgent extends VersionedEntity {
  /**
   * Auto-generated primary key. Also used as the LangGraph `thread_id`.
   * @format uuid
   */
  @PrimaryGeneratedColumn('uuid')
  id!: UUID;

  /** The company this agent belongs to. */
  @ManyToOne(() => TcpCompany, { nullable: false, onDelete: 'CASCADE' })
  company!: TcpCompany;

  /**
   * Foreign key for the owning {@link TcpCompany}.
   * @format uuid
   */
  @Column()
  companyId!: UUID;

  /** The role template this agent runs as. */
  @ManyToOne(() => TcpRole, { nullable: false, onDelete: 'CASCADE' })
  role!: TcpRole;

  /**
   * Foreign key for the {@link TcpRole} this agent is an instance of.
   * @format uuid
   */
  @Column()
  roleId!: UUID;

  /**
   * The {@link TcpAssignment} this agent works. Every agent has one — task
   * work uses the task's assignment; plain conversations, API-started agents,
   * and consultations get an auto-created "orphan" assignment. The agent's
   * mode is this assignment's mode (there is no mode column on the agent).
   */
  @ManyToOne(() => TcpAssignment, { nullable: false, onDelete: 'CASCADE' })
  assignment!: TcpAssignment;

  /**
   * Foreign key for the owning {@link TcpAssignment}.
   * @format uuid
   */
  @Column()
  assignmentId!: UUID;

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
  @Column({ type: 'text', transformer: sanitiseTextColumn })
  initialPrompt!: string;

  /** Timestamp when this agent record was created. */
  @CreateDateColumn()
  createdAt!: Date;

  /**
   * Final output produced by the agent on completion.
   * Set from the assignment `summary` on completion (via the tasks service's
   * `complete_assignment`), or as a fallback from the last AI message when the
   * loop exits naturally.
   */
  @Column({ type: 'text', nullable: true, transformer: sanitiseTextColumn })
  output!: string | null;

  /**
   * Storage changes accumulated by the agent loop during the current (or last) run.
   * Updated incrementally by tcp-agent as storage MCP tool calls complete.
   * Used to include context in completion/output-gate error messages.
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
   * Tool names (unprefixed, e.g. `complete_assignment`) that must have been
   * invoked successfully before the agent loop may end. Null means the default
   * (`['complete_assignment']`); an empty array disables enforcement.
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

  /**
   * Why this agent is paused; cleared on resume, and null whenever the agent
   * is not paused.
   *
   * Lets a resume path tell a shutdown drain apart from a pause that is
   * waiting on a reply — both have zero outstanding requests, so status alone
   * cannot distinguish them.
   */
  @Column({ type: 'varchar', nullable: true })
  pauseReason?: PauseReason | null;

  /**
   * When a `rate_limited` pause should be retried: the provider's hint, or
   * the backoff cadence. Null when auto-resume is off, so only an explicit
   * resume lifts the pause. Ignored for any other pause reason.
   */
  @Column({ nullable: true })
  resumeAfter?: Date;

  /**
   * Rate limits in a row without the agent getting an LLM response in
   * between — drives the doubling backoff, and starts again at 1 once a run
   * makes progress.
   */
  @Column({ type: 'int', default: 0 })
  rateLimitRetries!: number;
}
