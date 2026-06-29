import type { UUID } from 'crypto';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { LcpAgent } from './LcpAgent.model';
import { LcpCompany } from './LcpCompany.model';

/** Structured payload for {@link AuditEventType.AgentLoopCompletion} events. */
export interface AgentLoopCompletionSummary {
  summary: string;
  actions: string[];
  storage: {
    created: string[];
    modified: string[];
    deleted: string[];
    moved: { from: string; to: string }[];
  };
}

/** Categories of event captured in the audit log (per ADR-008). */
export const AuditEventType = {
  LlmRequest: 'llm_request',
  LlmResponse: 'llm_response',
  ToolCall: 'tool_call',
  ToolResult: 'tool_result',
  Decision: 'decision',
  StateChange: 'state_change',
  AgentLoopCompletion: 'agent_loop_completion',
} as const;

export type AuditEventType =
  (typeof AuditEventType)[keyof typeof AuditEventType];

/**
 * A single entry in the audit log for an agent run.
 * Rows are written by lcp-agent as it processes LangGraph events.
 * The composite index on `(companyId, agentId, timestamp)` supports efficient
 * time-ordered queries and live-stream reads per ADR-008.
 */
@Entity()
@Index(['companyId', 'agentId', 'timestamp'])
export class AuditEvent {
  /**
   * Auto-generated primary key.
   * @format uuid
   */
  @PrimaryGeneratedColumn('uuid')
  id!: UUID;

  /** When this event was recorded. Defaults to the current time. */
  @CreateDateColumn()
  timestamp!: Date;

  /** The company context for this event. */
  @ManyToOne(() => LcpCompany, { nullable: false, onDelete: 'CASCADE' })
  company!: LcpCompany;

  /**
   * Foreign key for the owning {@link LcpCompany}.
   * @format uuid
   */
  @Column()
  companyId!: UUID;

  /**
   * The role name at the time of the event (denormalised for query convenience
   * since the role may be updated after the run).
   */
  @Column({ type: 'varchar' })
  role!: string;

  /** The agent that produced this event. Nullable for system-level events. */
  @ManyToOne(() => LcpAgent, { nullable: true, onDelete: 'SET NULL' })
  agent!: LcpAgent | null;

  /**
   * Foreign key for the {@link LcpAgent} that produced this event.
   * @format uuid
   */
  @Column({ nullable: true, type: 'varchar' })
  agentId!: UUID | null;

  /** The category of event. */
  @Column({ type: 'varchar' })
  eventType!: AuditEventType;

  /**
   * Structured event payload. Content varies by {@link AuditEventType}:
   * - `llm_request` / `llm_response`: message content and token counts
   * - `tool_call` / `tool_result`: tool name, input, and output
   * - `decision`: summary and justification
   * - `state_change`: reason and new status
   */
  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;
}
