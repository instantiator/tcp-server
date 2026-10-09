import type { UUID } from '../uuid';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** How urgently a {@link TcpNotification} should be surfaced. */
export type NotificationSeverity = 'info' | 'warning' | 'error';

/** The condition a {@link TcpNotification} reports, routing its UI treatment. */
export type NotificationKind =
  | 'spend_threshold'
  | 'spend_reached'
  | 'spend_reset'
  | 'spend_untracked'
  | 'task_failed'
  | 'task_paused';

/**
 * A notice: application-wide (a spend threshold crossed, a cap reached, a
 * provider reporting no usage, …) and visible to every signed-in user, or
 * about one company's task (it failed, or a shutdown paused it) and visible
 * to that company's members. Either way, dismissed for everyone at once.
 * Named `TcpNotification` to avoid clashing with the DOM's global
 * `Notification` type; the table itself is named `notification`.
 */
@Entity('notification')
export class TcpNotification {
  /** @format uuid */
  @PrimaryGeneratedColumn('uuid')
  id!: UUID;

  /** How urgently this notification should be surfaced. */
  @Column({ type: 'varchar' })
  severity!: NotificationSeverity;

  /** The condition this notification reports. */
  @Column({ type: 'varchar' })
  kind!: NotificationKind;

  /** Human-readable notification text. */
  @Column({ type: 'varchar' })
  message!: string;

  /** Structured detail backing `message` (e.g. provider, percent, window). */
  @Column({ type: 'jsonb', nullable: true })
  params?: Record<string, unknown>;

  /**
   * Identifies a notification instance so a repeated condition (e.g. the same
   * threshold crossed twice) inserts once — a colliding insert is ignored.
   */
  @Column({ type: 'varchar', nullable: true, unique: true })
  dedupeKey?: string;

  /**
   * The company a task notice belongs to; null for an application-wide one.
   * @format uuid
   */
  @Column({ type: 'varchar', nullable: true })
  companyId?: UUID | null;

  /**
   * The task a task notice is about, for a link to it; null otherwise.
   * @format uuid
   */
  @Column({ type: 'varchar', nullable: true })
  taskId?: UUID | null;

  /** When this notification was raised. */
  @CreateDateColumn()
  createdAt!: Date;

  /** When a user dismissed this notification; null while still active. */
  @Column({ nullable: true })
  dismissedAt?: Date;
}
