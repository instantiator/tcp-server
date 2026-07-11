import type { UUID } from 'crypto';
import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import type { AgentRunConfig } from './AgentRunConfig.model';
import { LcpRole } from './LcpRole.model';
import type { LlmConfig } from './LlmConfig.model';
import type { WithLlmConfig } from './WithLlmConfig';

/**
 * Represents a company (tenant) within the LCP simulation.
 * Each company has its own isolated set of agents, memory, and resources.
 */
@Entity()
export class LcpCompany implements WithLlmConfig {
  /**
   * Auto-generated primary key for this company.
   * @format uuid
   */
  @PrimaryGeneratedColumn('uuid')
  id!: UUID;

  /**
   * URL-safe identifier used in API paths and agent namespacing.
   * Must be globally unique across all companies.
   * @minLength 1
   */
  @Column({ unique: true })
  slug!: string;

  /**
   * Human-readable display name for the company.
   * @minLength 1
   */
  @Column()
  name!: string;

  /**
   * Human-readable description for the company.
   * @minLength 1
   */
  @Column()
  description!: string;

  /**
   * Optional company-wide default LLM configuration. Roles that do not specify
   * their own {@link LcpRole.llmConfig} fall back to this value at run time,
   * then to the environment-configured LLM fallback (`LLM_PROVIDER` / `LLM_MODEL`),
   * before failing. Resolved via {@link LlmConfigResolver}.
   */
  @Column({ type: 'jsonb', nullable: true })
  llmConfig?: LlmConfig | null;

  /**
   * Optional company-wide default `systemPromptTemplate`. Used when a role
   * does not specify its own {@link LcpRole.systemPromptTemplate}; falls back
   * to `DEFAULT_SYSTEM_PROMPT_TEMPLATE` when neither is set. Resolved via
   * {@link SystemPromptTemplateResolver}.
   */
  @Column({ type: 'text', nullable: true })
  systemPromptTemplate?: string | null;

  /**
   * Additional MCP server identifiers made available to every agent in this
   * company, on top of the system's default servers and any extras listed
   * on the running role. Additive, not a precedence override — resolved via
   * {@link resolveMcpServerList}.
   */
  @Column({ type: 'jsonb', default: [] })
  mcpServerList!: string[];

  /**
   * IANA timezone name (e.g. `'Europe/London'`) used only for *display* and
   * prompt localization — CLI/UI timestamp formatting, and the `{{timezone}}`/
   * `{{localDatetime}}` prompt variables (see `buildPromptDateVars`). Never
   * used for storage (always UTC) or as a replacement for the UTC time given
   * to the LLM (`{{datetime}}` remains the authoritative anchor).
   */
  @Column({ type: 'varchar', nullable: true })
  timezone?: string | null;

  /**
   * Optional company context injected as prompt part 2 at agent start.
   * Describes the company environment: agent roster, shared storage layout,
   * company name and description, and any company-wide behavioural guidelines.
   *
   * When null, part 2 is omitted from the agent prompt.
   */
  @Column({ type: 'text', nullable: true })
  companyContext?: string | null;

  /**
   * Provider and model configuration used for generating and querying embeddings.
   * Must point to an OpenAI-compatible embeddings endpoint
   * (e.g. LM Studio `/v1/embeddings`, OpenAI `text-embedding-3-small`).
   *
   * When null, the RAG index and retrieval services are disabled for this company.
   * Stored as JSONB — same shape as {@link LlmConfig} but the `contextWindow` field
   * is ignored.
   */
  @Column({ type: 'jsonb', nullable: true })
  embeddingConfig?: LlmConfig | null;

  /**
   * Optional company-wide agent-loop resource overrides.
   * Applied when the running role has no {@link LcpRole.runConfig} set.
   * See {@link AgentRunConfig} for available fields.
   */
  @Column({ type: 'jsonb', nullable: true })
  runConfig?: AgentRunConfig | null;

  /**
   * Company-default planner role, used by {@link LcpTask.plannerRole} when a
   * task does not specify its own. Must belong to this company — enforced at
   * write time by `DbService`/`ApiService`, not by the FK alone.
   */
  @ManyToOne(() => LcpRole, { nullable: true, onDelete: 'SET NULL' })
  plannerRole?: LcpRole | null;

  /**
   * Foreign key for {@link plannerRole}.
   * @format uuid
   */
  @Column({ nullable: true })
  plannerRoleId?: UUID | null;
}
