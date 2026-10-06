import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** How a reached cap was lifted, if at all. */
export type CapDismissal = 'none' | 'until-reset' | 'indefinite';

/** The action a reached cap takes, mirroring `SPEND_CAPS`'s per-provider `action`. */
export type CapAction = 'pause' | 'finish-agents' | 'finish-tasks';

/**
 * Per-provider spend-cap state — the single source of truth both tcp-server
 * and tcp-agent read to evaluate and enforce caps. One row per provider that
 * has ever recorded usage.
 */
@Entity('spend_cap_state')
export class SpendCapState {
  /** Catalogue provider id this state belongs to. */
  @PrimaryColumn({ type: 'varchar' })
  provider!: string;

  /** Anchor timestamps (ISO strings) each configured window started counting from, keyed by `per`. */
  @Column({ type: 'jsonb', default: '{}' })
  windowStarts!: Record<string, string>;

  /** End of the window during which a reached limit stays in effect; null when no limit is reached. */
  @Column({ nullable: true })
  reachedUntil?: Date;

  /**
   * The reached limit's configured action, read by tcp-agent's gate to decide
   * its enforcement scope. Null whenever no limit is reached.
   */
  @Column({ type: 'varchar', nullable: true })
  action?: CapAction;

  /** Whether (and how) a user has lifted the reached state. */
  @Column({ type: 'varchar', default: 'none' })
  dismissal!: CapDismissal;

  /** When this row was last written. */
  @UpdateDateColumn()
  updatedAt!: Date;
}
