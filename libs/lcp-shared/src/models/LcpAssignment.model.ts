import type { UUID } from 'crypto';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type {
  LcpAssignmentCompletedArtifact,
  LcpAssignmentWorkingArtifact,
  LcpMaterialArtifact,
} from './LcpArtifact';
import {
  sanitiseArtifactsColumn,
  sanitiseTextColumn,
} from '../validation/sanitize';
import { LcpAgent } from './LcpAgent.model';
import { LcpCompany } from './LcpCompany.model';
import { LcpRole } from './LcpRole.model';
import { LcpTask } from './LcpTask.model';
import { VersionedEntity } from './VersionedEntity';

/**
 * The kind of work an assignment represents. The agent's mode IS its
 * assignment's mode — there is no separate mode column on {@link LcpAgent}.
 *
 * - `plan` — design a task's plan (`create_plan`).
 * - `implement` — carry out one plan step (`complete_assignment`).
 * - `qa` — review a completed step (`assure_assignment`).
 * - `chat` — a conversation with a user (no completion tool).
 * - `consultee` — answer another agent's consultation (`complete_assignment`).
 * - `finalise` — make a task's deliverables meet its expected outputs
 *   (`complete_assignment`), the task-level check after all steps + QA.
 */
export type LcpAssignmentMode =
  'plan' | 'implement' | 'qa' | 'chat' | 'consultee' | 'finalise';

/**
 * Lifecycle states for a {@link LcpAssignment}. A QA rejection returns the
 * assignment from `in-qa` to `in-progress` (`qaStatus`/`qaFeedback` are
 * cleared on that re-entry; `qaAttempts` is never reset).
 */
export type LcpAssignmentStatus =
  'ready' | 'in-progress' | 'in-qa' | 'succeeded' | 'failed' | 'cancelled';

/** Outcome of a QA review — set by `assure_assignment`; null while not under (or before) review. */
export type LcpAssignmentQaStatus = 'accepted' | 'rejected' | null;

/**
 * A unit of work performed by a single agent. Implement-mode assignments
 * belonging to a task, ordered by {@link orderIndex}, form that task's plan —
 * there is no separate plan entity. Assignments also exist outside any task
 * ("orphan" assignments — plain conversations/consultations, `taskId: null`)
 * and in `plan`/`qa` modes (the planner's own assignment, and QA review
 * assignments).
 */
@Entity()
@Index(['taskId', 'orderIndex'])
@Index(['companyId'])
@Index(['agentId'])
export class LcpAssignment extends VersionedEntity {
  /** @format uuid */
  @PrimaryGeneratedColumn('uuid')
  id!: UUID;

  /** The task this assignment belongs to. Null for orphan assignments. */
  @ManyToOne(() => LcpTask, { nullable: true, onDelete: 'CASCADE' })
  task?: LcpTask | null;

  /**
   * Foreign key for {@link task}. Null for orphan assignments.
   * @format uuid
   */
  @Column({ nullable: true })
  taskId?: UUID | null;

  /** The company this assignment belongs to — needed directly for orphans. */
  @ManyToOne(() => LcpCompany, { nullable: false, onDelete: 'CASCADE' })
  company!: LcpCompany;

  /**
   * Foreign key for the owning {@link LcpCompany}.
   * @format uuid
   */
  @Column()
  companyId!: UUID;

  /** The kind of work this assignment represents. */
  @Column({ type: 'varchar', default: 'implement' })
  mode!: LcpAssignmentMode;

  /**
   * Position in the task plan. Set only for implement-mode assignments
   * belonging to a task; null for orphans, plan-mode, and qa-mode
   * assignments.
   *
   * ponytail: a linear plan (one integer per step) is the shipped shape —
   * future DAG-shaped plans (branch/join) replace this with an edge list;
   * `selectNextAssignments` is the intended extension point.
   */
  @Column({ type: 'int', nullable: true })
  orderIndex?: number | null;

  /** The instructions given to the assigned agent. */
  @Column({ type: 'text', transformer: sanitiseTextColumn })
  prompt!: string;

  /**
   * Short identifier derived from the owning task's shortcode, this
   * assignment's position in the task's plan, and its mode — e.g.
   * `000-000-plan`, `000-001-implement`, `000-001-qa` (see
   * `buildAssignmentShortcode`). Null for orphan assignments (`taskId`
   * null — plain conversations and consultations spawned from one).
   */
  @Column({ type: 'varchar', nullable: true })
  shortcode?: string | null;

  /** The role this assignment must be worked by. */
  @ManyToOne(() => LcpRole, { nullable: false, onDelete: 'CASCADE' })
  role!: LcpRole;

  /**
   * Foreign key for {@link role}.
   * @format uuid
   */
  @Column()
  roleId!: UUID;

  /** Current lifecycle state of this assignment. */
  @Column({ type: 'varchar', default: 'ready' })
  status!: LcpAssignmentStatus;

  /** Why the assignment failed — QA exhaustion, agent run failure, etc. Null unless `status` is `failed`. */
  @Column({ type: 'text', nullable: true })
  failureReason!: string | null;

  /** The agent currently (or last) working this assignment. */
  @ManyToOne(() => LcpAgent, { nullable: true, onDelete: 'SET NULL' })
  agent?: LcpAgent | null;

  /**
   * Foreign key for {@link agent}.
   * @format uuid
   */
  @Column({ nullable: true })
  agentId?: UUID | null;

  /** qa-mode only: the assignment under review. */
  @ManyToOne(() => LcpAssignment, { nullable: true, onDelete: 'CASCADE' })
  targetAssignment?: LcpAssignment | null;

  /**
   * Foreign key for {@link targetAssignment}.
   * @format uuid
   */
  @Column({ nullable: true })
  targetAssignmentId?: UUID | null;

  /**
   * The assignment whose agent spawned this one (e.g. a consultation). Distinct
   * from {@link targetAssignment} (what a QA assignment reviews) — this is "who
   * created me", not "what am I evaluating".
   */
  @ManyToOne(() => LcpAssignment, { nullable: true, onDelete: 'SET NULL' })
  parentAssignment?: LcpAssignment | null;

  /**
   * Foreign key for {@link parentAssignment}.
   * @format uuid
   */
  @Column({ nullable: true })
  @Index()
  parentAssignmentId?: UUID | null;

  /**
   * Materials supplied to the assignment.
   *
   * Uses `simple-json` (stored as TEXT) for cross-DB compatibility with SQLite unit tests.
   */
  @Column({
    type: 'simple-json',
    default: '[]',
    transformer: sanitiseArtifactsColumn,
  })
  materials!: LcpMaterialArtifact[];

  /** Artifacts the assignment is expected to produce. */
  @Column({
    type: 'simple-json',
    default: '[]',
    transformer: sanitiseArtifactsColumn,
  })
  expected!: LcpAssignmentWorkingArtifact[];

  /** Set by `complete_assignment`: the artifacts the agent prepared for review. */
  @Column({
    type: 'simple-json',
    default: '[]',
    transformer: sanitiseArtifactsColumn,
  })
  prepared!: LcpAssignmentWorkingArtifact[];

  /** Set when QA accepts: the artifacts promoted into the assignment's completed directory. */
  @Column({
    type: 'simple-json',
    default: '[]',
    transformer: sanitiseArtifactsColumn,
  })
  approved!: LcpAssignmentCompletedArtifact[];

  /**
   * The completing agent's final answer, recorded by `complete_assignment`.
   * Becomes the agent's `output` when QA accepts.
   */
  @Column({ type: 'text', nullable: true, transformer: sanitiseTextColumn })
  summary!: string | null;

  /** Outcome of the current/last QA review. Cleared (with {@link qaFeedback}) whenever the assignment (re-)enters `in-progress`. */
  @Column({ type: 'varchar', nullable: true })
  qaStatus!: LcpAssignmentQaStatus;

  /** QA reviewer's feedback. Cleared alongside {@link qaStatus}. */
  @Column({ type: 'text', nullable: true, transformer: sanitiseTextColumn })
  qaFeedback!: string | null;

  /** Number of QA review cycles this assignment has been through. Never reset. */
  @Column({ type: 'int', default: 0 })
  qaAttempts!: number;

  /** Timestamp when this assignment was created. */
  @CreateDateColumn()
  createdAt!: Date;

  /** Timestamp of the last status or field update. */
  @UpdateDateColumn()
  updatedAt!: Date;
}
