import type { UUID } from '../uuid';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** Who authored a {@link ConversationMessage}. */
export type MessageAuthor = 'user' | 'agent';

/**
 * A single message in a {@link Conversation} thread.
 * Messages are append-only — one `agent` message (the question) followed by
 * zero or one `user` message (the reply that closes the conversation).
 */
@Entity()
@Index(['conversationId'])
export class ConversationMessage {
  /**
   * Auto-generated primary key.
   * @format uuid
   */
  @PrimaryGeneratedColumn('uuid')
  id!: UUID;

  /**
   * The conversation this message belongs to.
   * @format uuid
   */
  @Column({ type: 'varchar' })
  conversationId!: UUID;

  /** Whether this message was written by the agent or a human user. */
  @Column({ type: 'varchar' })
  author!: MessageAuthor;

  /**
   * OIDC identifier of the user who replied (null for agent messages).
   * @minLength 1
   */
  @Column({ type: 'varchar', nullable: true })
  authorIdentifier!: string | null;

  /** Message body. */
  @Column({ type: 'text' })
  content!: string;

  /** When this message was created. */
  @CreateDateColumn()
  timestamp!: Date;
}
