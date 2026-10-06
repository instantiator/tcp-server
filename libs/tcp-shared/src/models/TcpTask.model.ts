import type { UUID } from '../uuid';
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
  TcpMaterialArtifact,
  TcpTaskCompletedArtifact,
} from './TcpArtifact';
import {
  sanitiseArtifactsColumn,
  sanitiseTextColumn,
} from '../validation/sanitize';
import { TcpCompany } from './TcpCompany.model';
import { TcpRole } from './TcpRole.model';
import { VersionedEntity } from './VersionedEntity';

/**
 * Lifecycle states for a {@link TcpTask}. `planning` reflects an active
 * planner dispatch; other transitions derive from the task's implement-mode
 * assignments via {@link deriveTaskStatus}.
 */
export type TcpTaskStatus =
  | 'ready'
  | 'planning'
  | 'in-progress'
  // The plan (and its QA) is complete; a finalise agent is bringing the
  // deliverables up to the task's expected outputs before success.
  | 'finalising'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/**
 * A piece of work requested by a user. A planner agent turns a task into a
 * plan — an ordered list of implement-mode {@link TcpAssignment} records
 * (there is no separate plan entity; see `TcpAssignment.orderIndex`).
 */
@Entity()
@Index(['companyId', 'shortcode'], { unique: true })
export class TcpTask extends VersionedEntity {
  /** @format uuid */
  @PrimaryGeneratedColumn('uuid')
  id!: UUID;

  /** The company this task belongs to. */
  @ManyToOne(() => TcpCompany, { nullable: false, onDelete: 'CASCADE' })
  company!: TcpCompany;

  /**
   * Foreign key for the owning {@link TcpCompany}.
   * @format uuid
   */
  @Column()
  companyId!: UUID;

  /** The user's statement of the work to be done. */
  @Column({ type: 'text', transformer: sanitiseTextColumn })
  request!: string;

  /**
   * Short, per-company identifier assigned at creation (`'000'`, `'001'`,
   * …) — see {@link TcpCompany.nextTaskShortcodeIndex}. Unique within the
   * owning company only.
   */
  @Column()
  shortcode!: string;

  /**
   * Explicit planner role for this task. Falls back to
   * {@link TcpCompany.plannerRoleId} at start time when unset.
   */
  @ManyToOne(() => TcpRole, { nullable: true, onDelete: 'SET NULL' })
  plannerRole?: TcpRole | null;

  /**
   * Foreign key for {@link plannerRole}.
   * @format uuid
   */
  @Column({ nullable: true })
  plannerRoleId?: UUID | null;

  /** Current lifecycle state of this task. */
  @Column({ type: 'varchar', default: 'ready' })
  status!: TcpTaskStatus;

  /**
   * Task materials supplied at creation or upload time — `task-materials-path`
   * or `inline-text` artifacts only.
   *
   * Uses `simple-json` (stored as TEXT) for cross-DB compatibility with SQLite unit tests.
   */
  @Column({
    type: 'simple-json',
    default: '[]',
    transformer: sanitiseArtifactsColumn,
  })
  materials!: TcpMaterialArtifact[];

  /** Artifacts the task is expected to produce. */
  @Column({
    type: 'simple-json',
    default: '[]',
    transformer: sanitiseArtifactsColumn,
  })
  expected!: TcpTaskCompletedArtifact[];

  /** Set at finalisation: the artifacts actually produced by the task. */
  @Column({
    type: 'simple-json',
    nullable: true,
    transformer: sanitiseArtifactsColumn,
  })
  completed!: TcpTaskCompletedArtifact[] | null;

  /** Why the task failed — planner failure, QA exhaustion, etc. Null unless `status` is `failed`. */
  @Column({ type: 'text', nullable: true })
  failureReason!: string | null;

  /** Timestamp when this task was created. */
  @CreateDateColumn()
  createdAt!: Date;

  /** Timestamp of the last status or field update. */
  @UpdateDateColumn()
  updatedAt!: Date;

  /**
   * Set by an explicit start/resume action so the spend-cap gate (tcp-agent)
   * never re-pauses this task's agents before they next finish a turn.
   */
  @Column({ default: false })
  spendCapExempt!: boolean;
}
