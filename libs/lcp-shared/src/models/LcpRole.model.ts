import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { LcpCompany } from './LcpCompany.model';

/**
 * Configuration for a specific LLM provider and model.
 * API keys are never stored here — only the name of the environment variable that holds the key.
 */
export interface LlmConfig {
  /**
   * Identifies the provider. Known values: `'lm-studio'` (local OpenAI-compatible endpoint),
   * `'openai'`. Any string value is accepted to support future providers.
   */
  provider: string;

  /** The model identifier as expected by the provider API (e.g. `'gpt-4o'`, `'qwen3-5b'`). */
  model: string;

  /**
   * Base URL override for providers that are not hosted at their default endpoint.
   * Required for `'lm-studio'` (e.g. `'http://localhost:1234/v1'`).
   */
  baseUrl?: string;

  /**
   * Name of the environment variable that holds the API key for this provider.
   * The key is resolved at runtime and never stored in the database.
   */
  apiKeyEnvVar?: string;
}

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
  id!: string;

  /** The company this role belongs to. */
  @ManyToOne(() => LcpCompany, { nullable: false, onDelete: 'CASCADE' })
  company!: LcpCompany;

  /**
   * Foreign key column for the owning {@link LcpCompany}.
   * @format uuid
   */
  @Column()
  companyId!: string;

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
   * Stored as JSONB; API keys are resolved from environment variables at runtime.
   */
  @Column({ type: 'jsonb' })
  llmConfig!: LlmConfig;

  /**
   * Handlebars-style prompt template injected as the system message at agent start.
   * Available variables: `{{name}}`, `{{description}}`, `{{date}}`.
   */
  @Column({ type: 'text' })
  systemPromptTemplate!: string;

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
