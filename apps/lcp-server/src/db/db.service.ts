import {
  AgentStatus,
  AuditEvent,
  AuditEventType,
  CompanyUser,
  LcpAgent,
  LcpCompany,
  LcpRole,
} from '@lcp/shared';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import { DeepPartial, Repository } from 'typeorm';
import { SHARED_KNOWLEDGE_ROLE_SLUG } from '../storage/storage-keys';
import { LcpAgentTemplate } from '../templates/LcpAgentTemplate';
import { LcpCompanyTemplate } from '../templates/LcpCompanyTemplate';
import { isUUID } from '../utils/ObjectUtils';

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
    @InjectRepository(CompanyUser)
    private readonly companyUserRepo: Repository<CompanyUser>,
  ) {}

  // Company

  /**
   * Creates a new {@link LcpCompany} from template, replacing any existing
   * record with the same slug, and adds `creatorIdentifier` as a
   * {@link CompanyUser} with `memberType: 'creator'` (skipped if one already
   * exists for this company+identifier).
   */
  async createCompany(
    template: LcpCompanyTemplate,
    slug: string,
    creatorIdentifier: string,
    creatorName?: string | null,
  ): Promise<LcpCompany> {
    await this.companyRepo.delete({ slug });
    const company = await this.companyRepo.save({
      ...template,
      id: undefined!,
      slug,
    });

    const existingCreator = await this.companyUserRepo.findOneBy({
      companyId: company.id,
      identifier: creatorIdentifier,
    });
    if (!existingCreator) {
      await this.companyUserRepo.save(
        this.companyUserRepo.create({
          companyId: company.id,
          identifier: creatorIdentifier,
          name: creatorName ?? null,
          memberType: 'creator',
          roles: [],
          knowledgeDomains: [],
        }),
      );
    }

    return company;
  }

  /**
   * Either creates or updates an {@link LcpCompany}.
   * Accepts a deep-partial shape so callers can patch nested JSONB fields without
   * providing a complete object.
   *
   * The entity to update is resolved — in order — from `identifiers.id`,
   * `company.id`, then a lookup of `identifiers.slug`. If any identifier is
   * given but resolves to no existing row, this throws {@link NotFoundException}
   * rather than silently creating a new record — callers that want a create
   * must omit all three. There is no delete-then-recreate: an update is
   * always a merge-and-save onto the row already found, so there is never a
   * window where the row doesn't exist.
   *
   * @param company the company fields to create or merge
   * @param identifiers optional `id`/`slug` used to resolve an existing record to update
   */
  async setCompany(
    company: DeepPartial<LcpCompany>,
    identifiers: { id?: UUID; slug?: string } = {},
  ): Promise<LcpCompany> {
    // An identifier being *given* (even one that resolves to nothing) always
    // means "update" — only the total absence of id/slug means "create".
    // Without this distinction, a slug that doesn't exist would silently
    // fall through to creating a new (slug-less, invalid) row instead of a 404.
    const isUpdate =
      identifiers.id !== undefined ||
      company.id !== undefined ||
      identifiers.slug !== undefined;
    const idFromSlug = identifiers.slug
      ? (await this.companyRepo.findOneBy({ slug: identifiers.slug }))?.id
      : undefined;
    const updateIndex = identifiers.id ?? company.id ?? idFromSlug;

    const existing = updateIndex
      ? await this.companyRepo.findOneBy({ id: updateIndex })
      : null;
    if (isUpdate && !existing) {
      throw new NotFoundException(
        `Company ${updateIndex ?? identifiers.slug} not found`,
      );
    }

    const merged = existing
      ? {
          ...existing,
          ...company,
          // Deep-merge llmConfig so a partial patch (e.g. only model) preserves other fields.
          // When llmConfig is explicitly null, pass it through as-is to allow removal.
          llmConfig:
            company.llmConfig !== undefined
              ? company.llmConfig !== null && existing.llmConfig != null
                ? { ...existing.llmConfig, ...company.llmConfig }
                : company.llmConfig
              : existing.llmConfig,
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

  /**
   * Deletes a company by UUID. Cascades to its roles, agents, audit events,
   * conversations, knowledge chunks, episodic memory, and company users (see
   * `AddMissingCompanyRoleForeignKeys` migration). Returns `true` if a record
   * was deleted, `false` if no company with that id exists.
   */
  async deleteCompany(id: UUID): Promise<boolean> {
    const result = await this.companyRepo.delete(id);
    return (result.affected ?? 0) > 0;
  }

  // Role

  /**
   * Either creates or updates an {@link LcpRole}.
   * Accepts a deep-partial shape so callers can patch nested JSONB fields
   * without providing a complete object.
   *
   * Mirrors {@link setCompany}'s pattern: the entity to update is resolved —
   * in order — from `identifiers.id`, `role.id`, then a lookup of
   * `identifiers.slug` (scoped to `role.companyId`, since role slugs are
   * only unique within a company). If any identifier is given but resolves
   * to no existing row, this throws {@link NotFoundException}. On create,
   * the owning company must exist. No delete-then-recreate — an update is
   * always a merge-and-save onto the row already found.
   *
   * @param role the role fields to create or merge
   * @param identifiers optional `id`/`slug` used to resolve an existing record to update
   */
  async setRole(
    role: DeepPartial<LcpRole>,
    identifiers: { id?: UUID; slug?: string } = {},
  ): Promise<LcpRole> {
    // "shared" is reserved for the company-wide knowledge folder
    // (`knowledge/shared/`) — no role may claim it as its own slug.
    if (role.slug === SHARED_KNOWLEDGE_ROLE_SLUG) {
      throw new BadRequestException(
        `Role slug "${SHARED_KNOWLEDGE_ROLE_SLUG}" is reserved for company-wide knowledge and cannot be used by a role`,
      );
    }

    // See setCompany: an identifier being *given* (even one that resolves to
    // nothing) always means "update" — only its total absence means "create".
    const isUpdate =
      identifiers.id !== undefined ||
      role.id !== undefined ||
      identifiers.slug !== undefined;
    const idFromSlug =
      identifiers.slug && role.companyId
        ? (
            await this.roleRepo.findOneBy({
              slug: identifiers.slug,
              companyId: role.companyId,
            })
          )?.id
        : undefined;
    const updateIndex = identifiers.id ?? role.id ?? idFromSlug;

    const existing = updateIndex
      ? await this.roleRepo.findOneBy({ id: updateIndex })
      : null;
    if (isUpdate && !existing) {
      throw new NotFoundException(
        `Role ${updateIndex ?? identifiers.slug} not found`,
      );
    }

    if (!isUpdate) {
      const company = await this.companyRepo.findOneBy({
        id: role.companyId,
      });
      if (!company) {
        throw new NotFoundException(`Company ${role.companyId} not found`);
      }
    }

    const merged = existing
      ? {
          ...existing,
          ...role,
          llmConfig:
            role.llmConfig !== undefined
              ? role.llmConfig !== null && existing.llmConfig != null
                ? { ...existing.llmConfig, ...role.llmConfig }
                : role.llmConfig
              : existing.llmConfig,
        }
      : role;

    return this.roleRepo.save(this.roleRepo.create(merged));
  }

  /** Retrieves a role by its UUID. Returns `null` if not found. */
  async getRole(id: UUID): Promise<LcpRole | null> {
    return this.roleRepo.findOneBy({ id });
  }

  /**
   * Retrieves a role within a given company by its UUID or slug (role slugs
   * are unique only within their owning company, so the company must be
   * known). Returns `null` if not found.
   */
  async findRoleByIdOrSlug(
    companyId: UUID,
    identifier: string,
  ): Promise<LcpRole | null> {
    return isUUID(identifier)
      ? this.roleRepo.findOneBy({ id: identifier, companyId })
      : this.roleRepo.findOneBy({ slug: identifier, companyId });
  }

  /** Returns all roles for a given company. */
  async listRoles(companyId: UUID): Promise<LcpRole[]> {
    return this.roleRepo.findBy({ companyId });
  }

  /**
   * Deletes a role by UUID. Cascades to its agents, knowledge chunks,
   * episodic memory, and conversations (see
   * `AddMissingCompanyRoleForeignKeys` migration). Returns `true` if a
   * record was deleted, `false` if no role with that id exists.
   */
  async deleteRole(id: UUID): Promise<boolean> {
    const result = await this.roleRepo.delete(id);
    return (result.affected ?? 0) > 0;
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
