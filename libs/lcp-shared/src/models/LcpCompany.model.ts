import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

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
  id!: string;

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
}
