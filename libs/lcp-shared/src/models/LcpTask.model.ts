import type { UUID } from 'crypto';
import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type {
  LcpMaterialArtifact,
  LcpTaskCompletedArtifact,
} from './LcpArtifact';
import { LcpCompany } from './LcpCompany.model';
import { LcpRole } from './LcpRole.model';
import { VersionedEntity } from './VersionedEntity';

/**
 * Lifecycle states for a {@link LcpTask}. `planning` reflects an active
 * planner dispatch; other transitions derive from the task's implement-mode
 * assignments (see `deriveTaskStatus`).
 */
export type LcpTaskStatus =
  | 'ready'
  | 'planning'
  | 'in-progress'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/**
 * A piece of work requested by a user. A planner agent turns a task into a
 * plan — an ordered list of implement-mode {@link LcpAssignment} records
 * (there is no separate plan entity; see `LcpAssignment.orderIndex`).
 */
@Entity()
export class LcpTask extends VersionedEntity {
  /** @format uuid */
  @PrimaryGeneratedColumn('uuid')
  id!: UUID;

  /** The company this task belongs to. */
  @ManyToOne(() => LcpCompany, { nullable: false, onDelete: 'CASCADE' })
  company!: LcpCompany;

  /**
   * Foreign key for the owning {@link LcpCompany}.
   * @format uuid
   */
  @Column()
  companyId!: UUID;

  /** The user's statement of the work to be done. */
  @Column({ type: 'text' })
  request!: string;

  /**
   * Explicit planner role for this task. Falls back to
   * {@link LcpCompany.plannerRoleId} at start time when unset.
   */
  @ManyToOne(() => LcpRole, { nullable: true, onDelete: 'SET NULL' })
  plannerRole?: LcpRole | null;

  /**
   * Foreign key for {@link plannerRole}.
   * @format uuid
   */
  @Column({ nullable: true })
  plannerRoleId?: UUID | null;

  /** Current lifecycle state of this task. */
  @Column({ type: 'varchar', default: 'ready' })
  status!: LcpTaskStatus;

  /**
   * Task materials supplied at creation or upload time — `task-materials-path`
   * or `inline-text` artifacts only.
   *
   * Uses `simple-json` (stored as TEXT) for cross-DB compatibility with SQLite unit tests.
   */
  @Column({ type: 'simple-json', default: '[]' })
  materials!: LcpMaterialArtifact[];

  /** Artifacts the task is expected to produce. */
  @Column({ type: 'simple-json', default: '[]' })
  expected!: LcpTaskCompletedArtifact[];

  /** Set at finalisation: the artifacts actually produced by the task. */
  @Column({ type: 'simple-json', nullable: true })
  completed!: LcpTaskCompletedArtifact[] | null;

  /** Why the task failed — planner failure, QA exhaustion, etc. Null unless `status` is `failed`. */
  @Column({ type: 'text', nullable: true })
  failureReason!: string | null;

  /** Timestamp when this task was created. */
  @CreateDateColumn()
  createdAt!: Date;

  /** Timestamp of the last status or field update. */
  @UpdateDateColumn()
  updatedAt!: Date;
}
