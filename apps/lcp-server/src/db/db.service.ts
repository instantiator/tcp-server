import {
  AgentStatus,
  AuditEvent,
  AuditEventType,
  LcpAgent,
  LcpCompany,
  LcpRole,
} from '@lcp/shared';
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
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
   *
   * @param company the company to create or update
   * @param replace if `true`, removes any existing record matching the slug
   */
  async setCompany(
    company: Partial<LcpCompany>,
    replace: boolean,
  ): Promise<LcpCompany> {
    if (replace) {
      await this.companyRepo.delete({ slug: company.slug });
    }

    const existing = company.id
      ? await this.companyRepo.findOneBy({ id: company.id })
      : null;

    const merged = defined(existing) ? { ...existing, ...company } : company;

    // Guard: if llmDefault is being removed while roles rely on it, reject.
    // POST (slug-replace) is exempt — it cascade-deletes all roles first.
    if (!replace && !merged.llmDefault && merged.id) {
      const orphanCount = await this.roleRepo.count({
        where: { companyId: merged.id, llmConfig: IsNull() },
      });
      if (orphanCount > 0) {
        throw new BadRequestException(
          `Cannot remove llmDefault: ${orphanCount} role(s) in this company have no llmConfig`,
        );
      }
    }

    return this.companyRepo.save(this.companyRepo.create(merged));
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
    if (!template.llmConfig) {
      const company = await this.companyRepo.findOneByOrFail({
        id: template.companyId,
      });
      if (!company.llmDefault) {
        throw new BadRequestException(
          'Role has no llmConfig and the company has no llmDefault — at least one is required',
        );
      }
    }
    return this.roleRepo.save(this.roleRepo.create(template));
  }

  /** Retrieves a role by its UUID. Returns `null` if not found. */
  async getRole(id: string): Promise<LcpRole | null> {
    return this.roleRepo.findOneBy({ id });
  }

  /** Returns all roles for a given company. */
  async listRoles(companyId: string): Promise<LcpRole[]> {
    return this.roleRepo.findBy({ companyId });
  }

  // Agent

  /** Creates a new {@link LcpAgent} in the `idle` state. */
  async createAgent(template: LcpAgentTemplate): Promise<LcpAgent> {
    return this.agentRepo.save(this.agentRepo.create(template));
  }

  /** Retrieves an agent by its UUID. Returns `null` if not found. */
  async getAgent(id: string): Promise<LcpAgent | null> {
    return this.agentRepo.findOneBy({ id });
  }

  /**
   * Updates the status of an {@link LcpAgent}, and optionally sets its
   * LangGraph `threadId` on first dispatch.
   */
  async updateAgentStatus(
    id: string,
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
    companyId: string,
    role: string,
    agentId: string | null,
    eventType: AuditEventType,
    payload: Record<string, unknown>,
  ): Promise<AuditEvent> {
    return this.auditRepo.save(
      this.auditRepo.create({ companyId, role, agentId, eventType, payload }),
    );
  }
}
