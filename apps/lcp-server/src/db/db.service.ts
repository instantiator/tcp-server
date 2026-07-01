import {
  AgentStatus,
  AuditEvent,
  AuditEventType,
  LcpAgent,
  LcpCompany,
  LcpRole,
} from '@lcp/shared';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import { DeepPartial, Repository } from 'typeorm';
import { LcpAgentTemplate } from '../templates/LcpAgentTemplate';
import { LcpCompanyTemplate } from '../templates/LcpCompanyTemplate';
import { LcpRoleTemplate } from '../templates/LcpRoleTemplate';
import { defined, isUUID } from '../utils/ObjectUtils';

/**
 * Thin TypeORM wrapper providing create, update, and retrieval operations
 * for all shared entities.
 */
@Injectable()
export class DbService {
  constructor(
    @InjectRepository(LcpCompany)
    private readonly companyRepo: Repository<LcpCompany>,
    @InjectRepository(LcpRole)
    private readonly roleRepo: Repository<LcpRole>,
    @InjectRepository(LcpAgent)
    private readonly agentRepo: Repository<LcpAgent>,
    @InjectRepository(AuditEvent)
    private readonly auditRepo: Repository<AuditEvent>,
  ) {}

  // Company

  /**
   * Creates a new {@link LcpCompany} from template,
   * replacing any existing record with the same slug.
   */
  async createCompany(
    template: LcpCompanyTemplate,
    slug: string,
  ): Promise<LcpCompany> {
    await this.companyRepo.delete({ slug });
    return this.companyRepo.save({ ...template, id: undefined!, slug });
  }

  /**
   * Either creates or updates an {@link LcpCompany}.
   * Accepts a deep-partial shape so callers can patch nested JSONB fields without
   * providing a complete object.
   *
   * @param company the company fields to create or merge
   * @param replace if `true`, removes any existing record matching the slug first
   */
  async setCompany(
    company: DeepPartial<LcpCompany>,
    replace: boolean,
  ): Promise<LcpCompany> {
    if (replace) {
      await this.companyRepo.delete({ slug: company.slug });
    }

    const existing = company.id
      ? await this.companyRepo.findOneBy({ id: company.id })
      : null;

    const merged = defined(existing)
      ? {
          ...existing,
          ...company,
          // Deep-merge llmDefault so a partial patch (e.g. only model) preserves other fields.
          // When llmDefault is explicitly null, pass it through as-is to allow removal.
          llmDefault:
            company.llmDefault !== undefined
              ? company.llmDefault !== null && existing.llmDefault != null
                ? { ...existing.llmDefault, ...company.llmDefault }
                : company.llmDefault
              : existing.llmDefault,
        }
      : company;

    return this.companyRepo.save(this.companyRepo.create(merged));
  }

  /** Returns all {@link LcpCompany} records. */
  async listCompanies(): Promise<LcpCompany[]> {
    return this.companyRepo.find();
  }

  /** Retrieves a company by its UUID or slug. Returns `null` if not found. */
  async getCompany(identifier: string): Promise<LcpCompany | null> {
    return isUUID(identifier)
      ? this.companyRepo.findOneBy({ id: identifier })
      : this.companyRepo.findOneBy({ slug: identifier });
  }

  // Role

  /** Creates a new {@link LcpRole} from the given template. */
  async createRole(template: LcpRoleTemplate): Promise<LcpRole> {
    const company = await this.companyRepo.findOneBy({
      id: template.companyId,
    });
    if (!company) {
      throw new NotFoundException(`Company ${template.companyId} not found`);
    }
    return this.roleRepo.save(this.roleRepo.create(template));
  }

  /** Retrieves a role by its UUID. Returns `null` if not found. */
  async getRole(id: UUID): Promise<LcpRole | null> {
    return this.roleRepo.findOneBy({ id });
  }

  /**
   * Partially updates an existing {@link LcpRole} by id.
   * Deep-merges `llmConfig` so a partial patch (e.g. only `model`) preserves other fields.
   * Returns the updated role, or `null` if no role with that id exists.
   */
  async updateRole(
    id: UUID,
    partial: DeepPartial<Omit<LcpRole, 'id' | 'company'>>,
  ): Promise<LcpRole | null> {
    const existing = await this.roleRepo.findOneBy({ id });
    if (!existing) return null;
    const merged = {
      ...existing,
      ...partial,
      id,
      llmConfig:
        partial.llmConfig !== undefined
          ? { ...existing.llmConfig, ...partial.llmConfig }
          : existing.llmConfig,
    };
    return this.roleRepo.save(merged);
  }

  /** Returns all roles for a given company. */
  async listRoles(companyId: UUID): Promise<LcpRole[]> {
    return this.roleRepo.findBy({ companyId });
  }

  // Agent

  /** Creates a new {@link LcpAgent} in the `idle` state. */
  async createAgent(template: LcpAgentTemplate): Promise<LcpAgent> {
    return this.agentRepo.save(this.agentRepo.create(template));
  }

  /** Retrieves an agent by its UUID. Returns `null` if not found. */
  async getAgent(id: UUID): Promise<LcpAgent | null> {
    return this.agentRepo.findOneBy({ id });
  }

  /**
   * Physically deletes an {@link LcpAgent} and its associated {@link AuditEvent} rows.
   * Returns `true` if a record was deleted, `false` if no agent with that id exists.
   */
  async deleteAgent(id: UUID): Promise<boolean> {
    const result = await this.agentRepo.delete(id);
    return (result.affected ?? 0) > 0;
  }

  /**
   * Updates the status of an {@link LcpAgent}, and optionally sets its
   * LangGraph `threadId` on first dispatch.
   */
  async updateAgentStatus(
    id: UUID,
    status: AgentStatus,
    threadId?: string,
  ): Promise<void> {
    await this.agentRepo.update(id, {
      status,
      ...(threadId !== undefined && { threadId }),
    });
  }

  // Audit

  /**
   * Persists a single {@link AuditEvent} row.
   *
   * @param companyId owning company
   * @param role role name at time of event
   * @param agentId agent that produced the event, or `null` for system events
   * @param eventType category of event
   * @param payload structured event data
   */
  async saveAuditEvent(
    companyId: UUID,
    role: string,
    agentId: UUID | null,
    eventType: AuditEventType,
    payload: Record<string, unknown>,
  ): Promise<AuditEvent> {
    return this.auditRepo.save(
      this.auditRepo.create({ companyId, role, agentId, eventType, payload }),
    );
  }
}
