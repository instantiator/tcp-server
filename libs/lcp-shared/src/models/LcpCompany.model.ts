import type { UUID } from 'crypto';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { LlmConfig } from './LlmConfig.model';

/**
 * Represents a company (tenant) within the LCP simulation.
 * Each company has its own isolated set of agents, memory, and resources.
 */
@Entity()
export class LcpCompany {
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
   * Company-wide default LLM configuration. Roles that do not specify their
   * own {@link LcpRole.llmConfig} fall back to this value at run time.
   * At least one of `llmDefault` or the role's `llmConfig` must be set —
   * the API enforces this at role-creation time and when this field is removed.
   */
  @Column({ type: 'jsonb', nullable: true })
  llmDefault?: LlmConfig | null;
}
