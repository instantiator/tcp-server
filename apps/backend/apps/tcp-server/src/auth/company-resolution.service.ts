import { Conversation, TcpAssignment, TcpTask } from '@tcp/shared';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import type { Request } from 'express';
import { Repository } from 'typeorm';
import { DbService } from '../db/db.service';
import { isUUID } from '../utils/ObjectUtils';
import type { CompanyScopeSpec } from './company-scope.decorator';

/** Path characters that make a storage path a pattern rather than a location. */
const GLOB_CHARS = /[*?]/;

/**
 * Resolves the company a request targets, from the {@link CompanyScopeSpec}s
 * its route declares. Every user-facing route names its company somehow —
 * directly, or through a task, agent, assignment, role, conversation or
 * storage key — and this is the one place that mapping lives, so enforcement
 * cannot drift per controller.
 */
@Injectable()
export class CompanyResolutionService {
  constructor(
    private readonly db: DbService,
    @InjectRepository(TcpTask)
    private readonly taskRepo: Repository<TcpTask>,
    @InjectRepository(TcpAssignment)
    private readonly assignmentRepo: Repository<TcpAssignment>,
    @InjectRepository(Conversation)
    private readonly conversationRepo: Repository<Conversation>,
  ) {}

  /**
   * Returns the company id this request targets, or `null` when it carries
   * none of the route's handles (the caller decides whether that is a 400 or
   * a refusal).
   *
   * @throws {@link NotFoundException} when a handle is present but names
   *   nothing — asking for a company that doesn't exist is a 404, not a
   *   membership failure, and the two must not be conflated.
   */
  async resolve(req: Request, specs: CompanyScopeSpec[]): Promise<UUID | null> {
    for (const spec of specs) {
      const handle = readHandle(req, spec);
      if (handle === null) continue;
      return await this.resolveHandle(handle, spec);
    }
    return null;
  }

  /** Resolves a present handle to the company it belongs to. */
  private async resolveHandle(
    handle: string,
    spec: CompanyScopeSpec,
  ): Promise<UUID | null> {
    switch (spec.via) {
      case 'company':
        return this.companyByIdentifier(handle);
      case 'storagePath':
        return this.companyByStoragePath(handle);
      case 'task':
        return this.companyOf(
          'Task',
          handle,
          async (id) => (await this.taskRepo.findOneBy({ id }))?.companyId,
        );
      case 'assignment':
        return this.companyOf(
          'Assignment',
          handle,
          async (id) =>
            (await this.assignmentRepo.findOneBy({ id }))?.companyId,
        );
      case 'agent':
        return this.companyOf(
          'Agent',
          handle,
          async (id) => (await this.db.getAgent(id))?.companyId,
        );
      case 'role':
        return this.companyOf(
          'Role',
          handle,
          async (id) => (await this.db.getRole(id))?.companyId,
        );
      case 'conversation': {
        const conversation = await this.conversationRepo.findOneBy({
          slug: handle,
        });
        if (!conversation) {
          throw new NotFoundException(`Conversation ${handle} not found`);
        }
        return conversation.companyId;
      }
    }
  }

  /** Resolves a company handle (UUID or slug) to its id. */
  private async companyByIdentifier(handle: string): Promise<UUID> {
    const company = await this.db.getCompany(handle);
    if (!company) throw new NotFoundException(`Company ${handle} not found`);
    return company.id;
  }

  /**
   * Resolves the company owning a storage object key, whose first segment is
   * the company slug (see `storage-keys.ts`). A glob in that segment names no
   * single company and resolves to `null` — the caller refuses it, because a
   * pattern spanning companies is exactly the read enforcement exists to stop.
   */
  private async companyByStoragePath(handle: string): Promise<UUID | null> {
    const [slug] = handle.split('/');
    if (!slug || GLOB_CHARS.test(slug)) return null;
    return this.companyByIdentifier(slug);
  }

  /**
   * Resolves the company of a UUID-keyed entity. A handle that isn't a UUID
   * is a 404 rather than a query: the id columns are typed `uuid`, so passing
   * a malformed value through would surface as a database error.
   */
  private async companyOf(
    label: string,
    handle: string,
    lookup: (id: UUID) => Promise<UUID | undefined>,
  ): Promise<UUID> {
    if (!isUUID(handle)) {
      throw new NotFoundException(`${label} ${handle} not found`);
    }
    const companyId = await lookup(handle);
    if (!companyId) {
      throw new NotFoundException(`${label} ${handle} not found`);
    }
    return companyId;
  }
}

/**
 * Reads a spec's handle off the request, or `null` when it is absent. A
 * non-string value (a repeated query parameter, a nested body object) counts
 * as absent rather than being coerced — a handle nobody can resolve must not
 * look like one that resolved.
 */
function readHandle(req: Request, spec: CompanyScopeSpec): string | null {
  const source: unknown =
    spec.from === 'param'
      ? req.params
      : spec.from === 'query'
        ? req.query
        : req.body;
  if (typeof source !== 'object' || source === null) return null;
  const value = (source as Record<string, unknown>)[spec.key];
  if (typeof value !== 'string' || value === '') return null;
  return spec.ignore?.includes(value) ? null : value;
}
