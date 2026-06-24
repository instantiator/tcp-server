import type { UUID } from 'crypto';
import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { LcpCompany } from './LcpCompany.model';
import type { LlmConfig } from './LlmConfig.model';

/**
 * A role template that defines the behaviour and LLM configuration for an agent.
 * Multiple {@link LcpAgent} instances can run from the same role within a company.
 */
@Entity()
export class LcpRole {
  /**
   * Auto-generated primary key for this role.
   * @format uuid
   */
  @PrimaryGeneratedColumn('uuid')
  id!: UUID;

  /** The company this role belongs to. */
  @ManyToOne(() => LcpCompany, { nullable: false, onDelete: 'CASCADE' })
  company!: LcpCompany;

  /**
   * Foreign key column for the owning {@link LcpCompany}.
   * @format uuid
   */
  @Column()
  companyId!: UUID;

  /**
   * Short identifier for this role within the company (e.g. `'analyst'`, `'planner'`).
   * @minLength 1
   */
  @Column()
  name!: string;

  /**
   * Human-readable description of what this role does and what outputs it is expected to produce.
   * @minLength 1
   */
  @Column({ type: 'text' })
  description!: string;

  /**
   * LLM provider and model configuration for agents running in this role.
   * Stored as JSONB. When absent, the agent loop falls back to {@link LcpCompany.llmDefault}.
   */
  @Column({ type: 'jsonb', nullable: true })
  llmConfig?: LlmConfig | null;

  /**
   * Handlebars-style prompt template injected as the system message at agent start.
   * Available variables: `{{name}}`, `{{description}}`, `{{date}}`.
   */
  @Column({ type: 'text' })
  systemPromptTemplate!: string;

  /**
   * Optional role prompt injected as prompt part 1 immediately after the system prompt.
   * Covers role identity, attitude, domain knowledge, and behavioural guidelines
   * that are distinct from the system-level instructions.
   *
   * When null, part 1 is omitted — {@link systemPromptTemplate} continues to serve
   * as the sole pre-task context until a role prompt is explicitly set.
   */
  @Column({ type: 'text', nullable: true })
  rolePrompt?: string | null;

  /**
   * Knowledge domain tags that will be used for RAG retrieval once the memory system is built.
   * Stored now so roles can be defined ahead of the RAG implementation.
   * ponytail: unused for MVP; consumed by the RAG phase
   */
  @Column({ type: 'jsonb', default: [] })
  knowledgeDomains!: string[];

  /**
   * List of MCP server identifiers this role is permitted to call.
   * Stored now; wired to the agent loop once MCP servers are implemented.
   * ponytail: unused for MVP; consumed by the MCP integration phase
   */
  @Column({ type: 'jsonb', default: [] })
  mcpServerList!: string[];
}
