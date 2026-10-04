import { TcpCompany, TcpRole } from '@tcp/shared';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import { DeepPartial, Repository } from 'typeorm';
import { SHARED_KNOWLEDGE_ROLE_SLUG } from '../storage/storage-keys';
import { isUUID } from '../utils/ObjectUtils';
import { LlmDestinationPolicy, mergeLlmConfig } from './llm-destination-policy';

/** TypeORM operations for {@link TcpRole}, behind {@link DbService}. */
@Injectable()
export class RoleDbService {
  constructor(
    @InjectRepository(TcpRole)
    private readonly roleRepo: Repository<TcpRole>,
    @InjectRepository(TcpCompany)
    private readonly companyRepo: Repository<TcpCompany>,
    private readonly llmPolicy: LlmDestinationPolicy,
  ) {}

  /**
   * Either creates or updates an {@link TcpRole}.
   * Accepts a deep-partial shape so callers can patch nested JSONB fields
   * without providing a complete object.
   *
   * Mirrors {@link CompanyDbService.set}'s pattern: the entity to update is
   * resolved — in order — from `identifiers.id`, `role.id`, then a lookup of
   * `identifiers.slug` (scoped to `role.companyId`, since role slugs are
   * only unique within a company). If any identifier is given but resolves
   * to no existing row, this throws {@link NotFoundException}. On create,
   * the owning company must exist. No delete-then-recreate — an update is
   * always a merge-and-save onto the row already found.
   *
   * @param role the role fields to create or merge
   * @param identifiers optional `id`/`slug` used to resolve an existing record to update
   */
  async set(
    role: DeepPartial<TcpRole>,
    identifiers: { id?: UUID; slug?: string } = {},
  ): Promise<TcpRole> {
    // "shared" is reserved for the company-wide knowledge folder
    // (`knowledge/shared/`) — no role may claim it as its own slug.
    if (role.slug === SHARED_KNOWLEDGE_ROLE_SLUG) {
      throw new BadRequestException(
        `Role slug "${SHARED_KNOWLEDGE_ROLE_SLUG}" is reserved for company-wide knowledge and cannot be used by a role`,
      );
    }

    // See CompanyDbService.set: an identifier being *given* (even one that
    // resolves to nothing) always means "update" — only its total absence
    // means "create".
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
          llmConfig: mergeLlmConfig(existing.llmConfig, role.llmConfig),
        }
      : role;
    // As in CompanyDbService.set: only when this write touches it.
    if (role.llmConfig !== undefined) {
      this.llmPolicy.assertAllowed(merged.llmConfig, 'llmConfig');
    }

    return this.roleRepo.save(this.roleRepo.create(merged));
  }

  /** Retrieves a role by its UUID. Returns `null` if not found. */
  async get(id: UUID): Promise<TcpRole | null> {
    return this.roleRepo.findOneBy({ id });
  }

  /**
   * Retrieves a role within a given company by its UUID or slug (role slugs
   * are unique only within their owning company, so the company must be
   * known). Returns `null` if not found.
   */
  async findByIdOrSlug(
    companyId: UUID,
    identifier: string,
  ): Promise<TcpRole | null> {
    return isUUID(identifier)
      ? this.roleRepo.findOneBy({ id: identifier, companyId })
      : this.roleRepo.findOneBy({ slug: identifier, companyId });
  }

  /** Returns all roles for a given company. */
  async list(companyId: UUID): Promise<TcpRole[]> {
    return this.roleRepo.findBy({ companyId });
  }

  /**
   * Deletes a role by UUID. Cascades to its agents, knowledge chunks,
   * episodic memory, and conversations (see
   * `AddMissingCompanyRoleForeignKeys` migration). Returns `true` if a
   * record was deleted, `false` if no role with that id exists.
   */
  async delete(id: UUID): Promise<boolean> {
    const result = await this.roleRepo.delete(id);
    return (result.affected ?? 0) > 0;
  }
}
