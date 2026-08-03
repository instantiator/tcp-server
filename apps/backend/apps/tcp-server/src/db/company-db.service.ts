import { CompanyUser, TcpCompany, TcpRole } from '@tcp/shared';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import { DeepPartial, Repository } from 'typeorm';
import { TcpCompanyTemplate } from '../templates/TcpCompanyTemplate';
import { isUUID } from '../utils/ObjectUtils';

/** TypeORM operations for {@link TcpCompany}, behind {@link DbService}. */
@Injectable()
export class CompanyDbService {
  constructor(
    @InjectRepository(TcpCompany)
    private readonly companyRepo: Repository<TcpCompany>,
    @InjectRepository(TcpRole)
    private readonly roleRepo: Repository<TcpRole>,
    @InjectRepository(CompanyUser)
    private readonly companyUserRepo: Repository<CompanyUser>,
  ) {}

  /**
   * Creates a new {@link TcpCompany} from template, replacing any existing
   * record with the same slug, and adds `creatorIdentifier` as a
   * {@link CompanyUser} with `memberType: 'creator'` (skipped if one already
   * exists for this company+identifier).
   */
  async create(
    template: TcpCompanyTemplate,
    slug: string,
    creatorIdentifier: string,
    creatorName?: string | null,
  ): Promise<TcpCompany> {
    await this.companyRepo.delete({ slug });
    const company = await this.companyRepo.save({
      ...template,
      id: undefined!,
      slug,
    });

    // A brand-new company has no roles of its own yet, so a plannerRoleId
    // given at creation can never validly belong to it — validated here
    // (rather than skipped) so the failure is reported clearly instead of
    // silently leaving a dangling reference.
    if (template.plannerRoleId) {
      await this.assertPlannerRoleBelongsToCompany(
        company.id,
        template.plannerRoleId,
      ).catch(async (err: unknown) => {
        await this.companyRepo.delete(company.id);
        throw err;
      });
    }

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
   * Either creates or updates an {@link TcpCompany}.
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
  async set(
    company: DeepPartial<TcpCompany>,
    identifiers: { id?: UUID; slug?: string } = {},
  ): Promise<TcpCompany> {
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

    const targetCompanyId = existing?.id ?? company.id;
    if (company.plannerRoleId && targetCompanyId) {
      await this.assertPlannerRoleBelongsToCompany(
        targetCompanyId,
        company.plannerRoleId,
      );
    }

    return this.companyRepo.save(this.companyRepo.create(merged));
  }

  /** Returns all {@link TcpCompany} records. */
  async list(): Promise<TcpCompany[]> {
    return this.companyRepo.find();
  }

  /** Retrieves a company by its UUID or slug. Returns `null` if not found. */
  async get(identifier: string): Promise<TcpCompany | null> {
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
  async delete(id: UUID): Promise<boolean> {
    const result = await this.companyRepo.delete(id);
    return (result.affected ?? 0) > 0;
  }

  /** @throws {@link BadRequestException} when `plannerRoleId` does not belong to `companyId`. */
  private async assertPlannerRoleBelongsToCompany(
    companyId: UUID,
    plannerRoleId: UUID,
  ): Promise<void> {
    const role = await this.roleRepo.findOneBy({
      id: plannerRoleId,
      companyId,
    });
    if (!role) {
      throw new BadRequestException(
        `Role ${plannerRoleId} does not belong to company ${companyId}`,
      );
    }
  }
}
