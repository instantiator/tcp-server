import type { UUID } from 'crypto';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { VersionedEntity } from './VersionedEntity';

/** Lifecycle state of a {@link Conversation}. */
export type ConversationStatus = 'awaiting_user' | 'closed';

/**
 * A question posed by an agent to one or more human users.
 * Created when an agent calls `request_user_input`; closed when a human replies.
 *
 * The slug is human-readable (`{roleName}-{queryIndex}`) and is the primary
 * identifier used by CLI commands. It is unique per role.
 */
@Entity()
@Index(['companyId', 'status'])
export class Conversation extends VersionedEntity {
  /**
   * Auto-generated primary key.
   * @format uuid
   */
  @PrimaryGeneratedColumn('uuid')
  id!: UUID;

  /**
   * Human-readable unique identifier in the form `{role-name}-{queryIndex}`.
   * @minLength 1
   */
  @Column({ unique: true })
  slug!: string;

  /**
   * The company this conversation belongs to.
   * @format uuid
   */
  @Column({ type: 'varchar' })
  companyId!: UUID;

  /**
   * The role that originated this question (denormalised — kept even if role is later renamed).
   * @minLength 1
   */
  @Column({ type: 'varchar' })
  roleName!: string;

  /**
   * The role ID that originated this question.
   * @format uuid
   */
  @Column({ type: 'varchar', nullable: true })
  roleId!: UUID | null;

  /**
   * The agent that raised this question.
   * @format uuid
   */
  @Column({ type: 'varchar', nullable: true })
  agentId!: UUID | null;

  /** The question the agent is asking. */
  @Column({ type: 'text' })
  question!: string;

  /** Optional additional context provided by the agent alongside the question. */
  @Column({ type: 'text', nullable: true })
  context!: string | null;

  /** Current lifecycle state. */
  @Column({ type: 'varchar', default: 'awaiting_user' })
  status!: ConversationStatus;

  /** OIDC identifiers of the users this question was routed to. */
  @Column({ type: 'jsonb', default: '[]' })
  routedToIdentifiers!: string[];

  /** When this conversation was created. */
  @CreateDateColumn()
  createdAt!: Date;

  /** Set when status transitions to `closed`. */
  @Column({ nullable: true })
  closedAt?: Date;
}
