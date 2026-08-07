import {
  AgentStatus,
  AuditEvent,
  AuditEventType,
  TcpAgent,
  TcpCompany,
  TcpRole,
} from '@tcp/shared';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import { DeepPartial, Repository } from 'typeorm';
import { AgentDbService } from './agent-db.service';
import { CompanyDbService } from './company-db.service';
import { RoleDbService } from './role-db.service';
import { TcpAgentTemplate } from '../templates/TcpAgentTemplate';
import { TcpCompanyTemplate } from '../templates/TcpCompanyTemplate';

/**
 * Thin TypeORM wrapper providing create, update, and retrieval operations
 * for all shared entities.
 *
 * This is the facade every caller injects; the operations themselves are
 * grouped by entity in {@link CompanyDbService}, {@link RoleDbService} and
 * {@link AgentDbService}, each of which documents the behaviour in full.
 */
@Injectable()
export class DbService {
  constructor(
    private readonly companies: CompanyDbService,
    private readonly roles: RoleDbService,
    private readonly agents: AgentDbService,
    @InjectRepository(AuditEvent)
    private readonly auditRepo: Repository<AuditEvent>,
  ) {}

  // Company — see CompanyDbService

  /** Creates a company and its creator {@link CompanyUser} — {@link CompanyDbService.create}. */
  createCompany(
    template: TcpCompanyTemplate,
    slug: string,
    creatorIdentifier: string,
    creatorName?: string | null,
  ): Promise<TcpCompany> {
    return this.companies.create(
      template,
      slug,
      creatorIdentifier,
      creatorName,
    );
  }

  /** Creates or updates a company — {@link CompanyDbService.set}. */
  setCompany(
    company: DeepPartial<TcpCompany>,
    identifiers: { id?: UUID; slug?: string } = {},
  ): Promise<TcpCompany> {
    return this.companies.set(company, identifiers);
  }

  /** Returns all companies — {@link CompanyDbService.list}. */
  listCompanies(): Promise<TcpCompany[]> {
    return this.companies.list();
  }

  /** Retrieves a company by UUID or slug — {@link CompanyDbService.get}. */
  getCompany(identifier: string): Promise<TcpCompany | null> {
    return this.companies.get(identifier);
  }

  /** Deletes a company and its dependants — {@link CompanyDbService.delete}. */
  deleteCompany(id: UUID): Promise<boolean> {
    return this.companies.delete(id);
  }

  // Role — see RoleDbService

  /** Creates or updates a role — {@link RoleDbService.set}. */
  setRole(
    role: DeepPartial<TcpRole>,
    identifiers: { id?: UUID; slug?: string } = {},
  ): Promise<TcpRole> {
    return this.roles.set(role, identifiers);
  }

  /** Retrieves a role by UUID — {@link RoleDbService.get}. */
  getRole(id: UUID): Promise<TcpRole | null> {
    return this.roles.get(id);
  }

  /** Retrieves a role within a company by UUID or slug — {@link RoleDbService.findByIdOrSlug}. */
  findRoleByIdOrSlug(
    companyId: UUID,
    identifier: string,
  ): Promise<TcpRole | null> {
    return this.roles.findByIdOrSlug(companyId, identifier);
  }

  /** Returns all roles for a company — {@link RoleDbService.list}. */
  listRoles(companyId: UUID): Promise<TcpRole[]> {
    return this.roles.list(companyId);
  }

  /** Deletes a role and its dependants — {@link RoleDbService.delete}. */
  deleteRole(id: UUID): Promise<boolean> {
    return this.roles.delete(id);
  }

  // Agent — see AgentDbService

  /** Creates an agent and, when needed, its orphan assignment — {@link AgentDbService.create}. */
  createAgent(template: TcpAgentTemplate): Promise<TcpAgent> {
    return this.agents.create(template);
  }

  /** Retrieves an agent by UUID — {@link AgentDbService.get}. */
  getAgent(id: UUID): Promise<TcpAgent | null> {
    return this.agents.get(id);
  }

  /** Lists agents by company/role/assignment/status — {@link AgentDbService.list}. */
  listAgents(filter: {
    companyId?: UUID;
    roleId?: UUID;
    assignmentId?: UUID;
    status?: AgentStatus;
  }): Promise<TcpAgent[]> {
    return this.agents.list(filter);
  }

  /** Deletes an agent and its audit rows — {@link AgentDbService.delete}. */
  deleteAgent(id: UUID): Promise<boolean> {
    return this.agents.delete(id);
  }

  /** Updates an agent's status (and optionally its threadId) — {@link AgentDbService.updateStatus}. */
  updateAgentStatus(
    id: UUID,
    status: AgentStatus,
    threadId?: string,
  ): Promise<void> {
    return this.agents.updateStatus(id, status, threadId);
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
