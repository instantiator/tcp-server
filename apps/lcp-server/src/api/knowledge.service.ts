import { LcpCompany, LcpRole } from '@lcp/shared';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { KnowledgeReindexService } from '../rag/knowledge-reindex.service';
import { KnowledgeScope } from '../storage/storage-keys';
import {
  Originators,
  StorageObject,
  StorageService,
} from '../storage/storage.service';
import { isUUID } from '../utils/ObjectUtils';

/** Summary returned by {@link KnowledgeService.list}. */
export interface DocumentSummary {
  /** Full MinIO object key (used as {@link KnowledgeChunk.documentPath}). */
  key: string;
  /** Filename within the knowledge scope's directory. */
  name: string;
  /** File size in bytes. */
  size: number;
  /** ISO 8601 last-modified timestamp. */
  lastModified: string;
}

/** Identifies which knowledge scope a {@link KnowledgeService} call targets. */
export type KnowledgeScopeRef =
  | { kind: 'role'; roleId: UUID }
  | { kind: 'company'; companyId: string };

/** A resolved knowledge scope, with the entities needed to address storage and RAG chunks. */
interface ResolvedScope {
  company: LcpCompany;
  role: LcpRole | null;
}

/**
 * Manages OKF knowledge-base documents for a role, or for a company's
 * shared (company-wide) knowledge.
 *
 * Stores documents in MinIO under `{companySlug}/knowledge/{roleSlug}/` (or
 * `{companySlug}/knowledge/shared/` for company scope). RAG embeddings are
 * kept in sync by {@link StorageService}'s write hook, which enqueues a
 * scope rebuild via {@link KnowledgeReindexService} — this service never
 * indexes synchronously.
 */
@Injectable()
export class KnowledgeService {
  constructor(
    private readonly storage: StorageService,
    private readonly reindex: KnowledgeReindexService,
    @InjectRepository(LcpRole)
    private readonly roleRepo: Repository<LcpRole>,
    @InjectRepository(LcpCompany)
    private readonly companyRepo: Repository<LcpCompany>,
  ) {}

  /**
   * Lists all OKF documents currently stored for the scope.
   *
   * @throws {@link NotFoundException} when the role/company does not exist.
   */
  async list(ref: KnowledgeScopeRef): Promise<DocumentSummary[]> {
    const { company, role } = await this.resolveScope(ref);
    const objects = await this.storage.listKnowledgeFiles(
      toStorageScope(company, role),
    );
    return objects.map(toSummary);
  }

  /**
   * Returns a document's text content.
   *
   * @throws {@link NotFoundException} when the role/company or the file does not exist.
   */
  async get(ref: KnowledgeScopeRef, filename: string): Promise<string> {
    const { company, role } = await this.resolveScope(ref);
    const content = await this.storage.getKnowledgeFile(
      toStorageScope(company, role),
      filename,
    );
    if (content === null) {
      throw new NotFoundException(`File ${filename} not found`);
    }
    return content;
  }

  /**
   * Stores a document. Its RAG chunks are (re)built asynchronously by the
   * storage write hook (see {@link KnowledgeReindexService}), so indexing is
   * not awaited here.
   *
   * If a document with the same `filename` already exists, it is overwritten.
   *
   * @throws {@link NotFoundException} when the role/company does not exist.
   * @returns The {@link DocumentSummary} for the newly stored document.
   */
  async store(
    ref: KnowledgeScopeRef,
    filename: string,
    content: Buffer,
    originators?: Originators,
  ): Promise<DocumentSummary> {
    const { company, role } = await this.resolveScope(ref);
    const key = await this.storage.putKnowledgeFile(
      toStorageScope(company, role),
      filename,
      content,
      originators,
    );
    return {
      key,
      name: filename,
      size: content.byteLength,
      lastModified: new Date().toISOString(),
    };
  }

  /**
   * Deletes a document by filename. Its RAG chunks are removed by the
   * subsequent scope rebuild triggered by the storage write hook.
   *
   * An unknown filename is not an error — the operation is idempotent.
   *
   * @throws {@link NotFoundException} when the role/company does not exist.
   */
  async delete(
    ref: KnowledgeScopeRef,
    filename: string,
    originators?: Originators,
  ): Promise<void> {
    const { company, role } = await this.resolveScope(ref);
    const scope = toStorageScope(company, role);
    try {
      await this.storage.deleteKnowledgeFile(scope, filename, originators);
    } catch (err) {
      if (!(err instanceof NotFoundException)) throw err;
    }
  }

  /**
   * Bumps every knowledge scope of a company (shared + each role), enqueuing a
   * rebuild for each — backs the manual `POST .../knowledge/reindex` trigger.
   *
   * @throws {@link NotFoundException} when the company does not exist.
   */
  async reindexCompany(companyId: string): Promise<void> {
    const { company } = await this.resolveScope({ kind: 'company', companyId });
    await this.reindex.bumpCompany(company);
  }

  /** Resolves a {@link KnowledgeScopeRef} to its owning role (if any) and company. */
  private async resolveScope(ref: KnowledgeScopeRef): Promise<ResolvedScope> {
    if (ref.kind === 'role') {
      const role = await this.roleRepo.findOneBy({ id: ref.roleId });
      if (!role) throw new NotFoundException(`Role ${ref.roleId} not found`);
      const company = await this.companyRepo.findOneBy({ id: role.companyId });
      if (!company) {
        throw new NotFoundException(`Company ${role.companyId} not found`);
      }
      return { company, role };
    }

    const company = isUUID(ref.companyId)
      ? await this.companyRepo.findOneBy({ id: ref.companyId })
      : await this.companyRepo.findOneBy({ slug: ref.companyId });
    if (!company) {
      throw new NotFoundException(`Company ${ref.companyId} not found`);
    }
    return { company, role: null };
  }
}

function toStorageScope(
  company: LcpCompany,
  role: LcpRole | null,
): KnowledgeScope {
  return { companySlug: company.slug, roleSlug: role?.slug ?? null };
}

function toSummary(obj: StorageObject): DocumentSummary {
  return {
    key: obj.key,
    name: obj.name,
    size: obj.size,
    lastModified: obj.lastModified.toISOString(),
  };
}
