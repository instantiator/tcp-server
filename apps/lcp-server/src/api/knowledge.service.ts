import {
  KnowledgeChunk,
  KnowledgeIndexState,
  LcpCompany,
  LcpRole,
  resolveEmbeddingConfig,
  resolveEnvEmbeddingConfig,
} from '@lcp/shared';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import { IsNull, Repository } from 'typeorm';
import { KnowledgeReindexService } from '../rag/knowledge-reindex.service';
import { RagChunk, RagRetrievalService } from '../rag/rag-retrieval.service';
import { KnowledgeScope } from '../storage/storage-keys';
import {
  Originators,
  StorageObject,
  StorageService,
} from '../storage/storage.service';
import { isUUID } from '../utils/ObjectUtils';
import { computeEmbeddingConfigWarning } from './validation-warnings';

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
  { kind: 'role'; roleId: UUID } | { kind: 'company'; companyId: string };

/** Indexing status of a single knowledge scope, returned by {@link KnowledgeService.status}. */
export interface KnowledgeStatus {
  /** Number of documents currently stored in the scope. */
  documentCount: number;
  /** Combined size in bytes of all documents in the scope. */
  totalBytes: number;
  /** Number of RAG chunks currently indexed for the scope. */
  chunkCount: number;
  /** Current {@link KnowledgeIndexState.generation} for the scope (0 if never bumped). */
  generation: number;
  /** ISO 8601 timestamp of the last *successful* rebuild, or `null` if none has completed. */
  lastIndexedAt: string | null;
  /** True if a rebuild job for the scope is currently queued or running. */
  indexing: boolean;
  /** Error message from the most recent failed rebuild, or `null` if the last rebuild succeeded (or none has run). */
  lastError: string | null;
  /** ISO 8601 timestamp {@link lastError} was recorded, or `null` if unset. */
  lastErrorAt: string | null;
}

/** Indexing status for a whole company: its shared scope plus every role. */
export interface CompanyKnowledgeStatus {
  /** Status of the company's shared (`knowledge/shared/`) scope. */
  shared: KnowledgeStatus;
  /** Status of each role's scope. */
  roles: { roleId: UUID; roleSlug: string; status: KnowledgeStatus }[];
}

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
    private readonly ragRetrieval: RagRetrievalService,
    private readonly config: ConfigService,
    @InjectRepository(LcpRole)
    private readonly roleRepo: Repository<LcpRole>,
    @InjectRepository(LcpCompany)
    private readonly companyRepo: Repository<LcpCompany>,
    @InjectRepository(KnowledgeChunk)
    private readonly chunkRepo: Repository<KnowledgeChunk>,
    @InjectRepository(KnowledgeIndexState)
    private readonly stateRepo: Repository<KnowledgeIndexState>,
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

  /**
   * Runs a RAG similarity search for a role, exactly as prompt assembly
   * would, without invoking any chat/LLM call — see
   * {@link RagRetrievalService.retrieve} for the scoping and threshold rules.
   *
   * @throws {@link NotFoundException} when the role does not exist.
   */
  async queryRag(
    roleId: UUID,
    query: string,
    topK?: number,
    threshold?: number,
  ): Promise<RagChunk[]> {
    const { company } = await this.resolveScope({ kind: 'role', roleId });
    return this.ragRetrieval.retrieve(
      roleId,
      company.id,
      query,
      resolveEmbeddingConfig(company, resolveEnvEmbeddingConfig(this.config)),
      topK,
      threshold,
    );
  }

  /**
   * Reports indexing status (document/chunk counts, size, generation, and
   * whether a rebuild is in progress) for a single scope.
   *
   * @throws {@link NotFoundException} when the role/company does not exist.
   */
  async status(ref: KnowledgeScopeRef): Promise<KnowledgeStatus> {
    const { company, role } = await this.resolveScope(ref);
    return this.computeStatus(company, role);
  }

  /**
   * Warnings for the `X-Lcp-Warnings` header on any knowledge endpoint
   * touching this scope: whether RAG indexing is configured at all (company
   * `embeddingConfig`, or the `EMBEDDING_*` env fallback), and whether the
   * most recent rebuild failed (e.g. the embedding endpoint was
   * unreachable) — both are otherwise invisible failure modes (see
   * {@link KnowledgeReindexService.rebuild}).
   *
   * For a company-scoped ref, only the shared scope's own error is checked
   * — an individual role's error is visible by scoping into that role, or
   * via {@link statusForCompany}'s per-role breakdown.
   *
   * @throws {@link NotFoundException} when the role/company does not exist.
   */
  async embeddingWarnings(ref: KnowledgeScopeRef): Promise<string[]> {
    const { company, role } = await this.resolveScope(ref);
    const warnings = computeEmbeddingConfigWarning(
      company,
      resolveEnvEmbeddingConfig(this.config),
    );
    const state = await this.stateRepo.findOne({
      where: { companyId: company.id, roleId: role?.id ?? IsNull() },
    });
    if (state?.lastError) {
      const when = state.lastErrorAt
        ? ` (${state.lastErrorAt.toISOString()})`
        : '';
      warnings.push(`Last reindex failed: ${state.lastError}${when}`);
    }
    return warnings;
  }

  /**
   * Reports indexing status for every scope of a company: its shared scope
   * plus each role.
   *
   * @throws {@link NotFoundException} when the company does not exist.
   */
  async statusForCompany(companyId: string): Promise<CompanyKnowledgeStatus> {
    const { company } = await this.resolveScope({ kind: 'company', companyId });
    const roles = await this.roleRepo.findBy({ companyId: company.id });
    const shared = await this.computeStatus(company, null);
    const roleStatuses = await Promise.all(
      roles.map(async (role) => ({
        roleId: role.id,
        roleSlug: role.slug,
        status: await this.computeStatus(company, role),
      })),
    );
    return { shared, roles: roleStatuses };
  }

  /** Computes a {@link KnowledgeStatus} for an already-resolved company/role scope. */
  private async computeStatus(
    company: LcpCompany,
    role: LcpRole | null,
  ): Promise<KnowledgeStatus> {
    const roleId = role?.id ?? null;
    const [objects, chunkCount, state, indexing] = await Promise.all([
      this.storage.listKnowledgeFiles(toStorageScope(company, role)),
      this.chunkRepo.count({
        where: { companyId: company.id, roleId: roleId ?? IsNull() },
      }),
      this.stateRepo.findOne({
        where: { companyId: company.id, roleId: roleId ?? IsNull() },
      }),
      this.reindex.isRebuilding(company.id, roleId),
    ]);
    return {
      documentCount: objects.length,
      totalBytes: objects.reduce((sum, obj) => sum + obj.size, 0),
      chunkCount,
      generation: state?.generation ?? 0,
      lastIndexedAt: state?.fingerprint ? state.updatedAt.toISOString() : null,
      indexing,
      lastError: state?.lastError ?? null,
      lastErrorAt: state?.lastErrorAt?.toISOString() ?? null,
    };
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
