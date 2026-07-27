import type { UUID } from 'crypto';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** Membership tier for a {@link CompanyUser} within a company. */
export type MemberType = 'creator' | 'owner' | 'member';

/**
 * A human user associated with a company.
 * Used for query routing (matching conversations to the right user) and
 * for the human-in-the-loop pause/resume flow in Phases 5–6.
 */
@Entity()
@Index(['companyId', 'identifier'], { unique: true })
export class CompanyUser {
  /**
   * Auto-generated primary key.
   * @format uuid
   */
  @PrimaryGeneratedColumn('uuid')
  id!: UUID;

  /**
   * The company this user belongs to.
   * @format uuid
   */
  @Column({ type: 'varchar' })
  companyId!: UUID;

  /**
   * OIDC subject (`sub`) claim or email address — unique per company.
   * @minLength 1
   */
  @Column({ type: 'varchar' })
  identifier!: string;

  /**
   * Display name for this user (optional).
   * @minLength 1
   */
  @Column({ type: 'varchar', nullable: true })
  name!: string | null;

  /** Membership tier. `creator` is set on company creation and cannot be removed. */
  @Column({ type: 'varchar' })
  memberType!: MemberType;

  @Column({ type: 'jsonb', default: '[]' })
  roles!: string[];

  /**
   * Knowledge domains this user covers (e.g. `"finance"`, `"legal"`).
   * Used by query routing to prefer the best-matched user.
   */
  @Column({ type: 'jsonb', default: '[]' })
  knowledgeDomains!: string[];

  /** When this user was added to the company. */
  @CreateDateColumn()
  createdAt!: Date;
}
