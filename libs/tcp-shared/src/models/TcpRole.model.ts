import type { UUID } from 'crypto';
import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import type { AgentRunConfig } from './AgentRunConfig.model';
import { TcpCompany } from './TcpCompany.model';
import type { LlmConfig } from './LlmConfig.model';
import type { WithLlmConfig } from './WithLlmConfig';

/**
 * A role template that defines the behaviour and LLM configuration for an agent.
 * Multiple {@link TcpAgent} instances can run from the same role within a company.
 */
@Entity()
export class TcpRole implements WithLlmConfig {
  /**
   * Auto-generated primary key for this role.
   * @format uuid
   */
  @PrimaryGeneratedColumn('uuid')
  id!: UUID;

  /** The company this role belongs to. */
  @ManyToOne(() => TcpCompany, { nullable: false, onDelete: 'CASCADE' })
  company!: TcpCompany;

  /**
   * Foreign key column for the owning {@link TcpCompany}.
   * @format uuid
   */
  @Column()
  companyId!: UUID;

  /**
   * URL-safe identifier used to address this role without its UUID (e.g. in
   * `tcp-cli` or agent-to-agent consultation). Unique **within the owning
   * company** only — unlike {@link TcpCompany.slug}, which is unique
   * globally, the same role slug may be reused across different companies.
   * @minLength 1
   */
  @Column()
  slug!: string;

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
   * Stored as JSONB. When absent, resolved via {@link LlmConfigResolver}
   * against {@link TcpCompany.llmConfig}, then the environment fallback.
   */
  @Column({ type: 'jsonb', nullable: true })
  llmConfig?: LlmConfig | null;

  /**
   * Handlebars-style prompt template injected as the system message at agent start.
   * Optional — when blank, resolved via {@link SystemPromptTemplateResolver}
   * against {@link TcpCompany.systemPromptTemplate}, then
   * `DEFAULT_SYSTEM_PROMPT_TEMPLATE`.
   *
   * Available variables: `{{name}}`, `{{description}}`, `{{date}}`,
   * `{{datetime}}`, `{{timezone}}`, `{{localDatetime}}`, `{{companyId}}`,
   * `{{roleId}}`. The latter two let the agent supply identifiers required by
   * company- and role-scoped MCP tool calls.
   */
  @Column({ type: 'text', nullable: true })
  systemPromptTemplate?: string | null;

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

  /**
   * Optional agent-loop resource overrides for agents running in this role.
   * Takes precedence over {@link TcpCompany.runConfig} and environment variables.
   * See {@link AgentRunConfig} for available fields.
   */
  @Column({ type: 'jsonb', nullable: true })
  runConfig?: AgentRunConfig | null;

  /**
   * Monotonically incrementing counter used to generate unique {@link Conversation} slugs.
   * Incremented atomically (raw SQL `UPDATE … RETURNING`) on each new conversation.
   */
  @Column({ type: 'int', default: 0 })
  queryIndex!: number;
}
