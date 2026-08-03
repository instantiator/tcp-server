import type { UUID } from '../uuid';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { VersionedEntity } from './VersionedEntity';

/** Lifecycle states for an inter-agent consultation. */
export type ConsultationStatus = 'pending' | 'complete' | 'failed';

/**
 * Tracks a paused agent waiting for another agent's consultation response.
 *
 * Created when an agent calls `request_agent_consultation` via the interactions
 * MCP server. The calling agent is set to {@link AgentStatus.Paused} until the
 * consultation agent completes and `PauseAndResumeService.completeAgent()` finds
 * this record and re-enqueues the calling agent.
 */
@Entity()
@Index(['consultationAgentId'])
@Index(['callingAgentId', 'status'])
export class PendingConsultation extends VersionedEntity {
  /** @format uuid */
  @PrimaryGeneratedColumn('uuid')
  id!: UUID;

  /** The agent that is paused awaiting the consultation result. */
  @Column({ type: 'varchar' })
  callingAgentId!: UUID;

  /** The newly created agent that will perform the consultation. */
  @Column({ type: 'varchar' })
  consultationAgentId!: UUID;

  /** Company owning both agents. */
  @Column({ type: 'varchar' })
  companyId!: UUID;

  /** Current state of the consultation. */
  @Column({ type: 'varchar', default: 'pending' })
  status!: ConsultationStatus;

  /**
   * The consultation result written by the consulting agent on completion.
   * Null until the consultation is complete.
   */
  @Column({ type: 'text', nullable: true })
  result!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
