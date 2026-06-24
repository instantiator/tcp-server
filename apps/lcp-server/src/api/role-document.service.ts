import { LcpCompany, LcpRole } from '@lcp/shared';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { RagIndexService } from '../rag/rag-index.service';
import { MinioService, StorageObject } from '../storage/minio.service';

/** Summary returned by {@link RoleDocumentService.listDocuments}. */
export interface DocumentSummary {
  /** Full MinIO object key (used as {@link KnowledgeChunk.documentPath}). */
  key: string;
  /** Filename within the role's knowledge directory. */
  name: string;
  /** File size in bytes. */
  size: number;
  /** ISO 8601 last-modified timestamp. */
  lastModified: string;
}

/**
 * Manages OKF knowledge-base documents for a role.
 *
 * Stores documents in MinIO under `{companySlug}/knowledge/{roleName}/`
 * and keeps the RAG index in sync via {@link RagIndexService}.
 */
@Injectable()
export class RoleDocumentService {
  constructor(
    private readonly minio: MinioService,
    private readonly ragIndex: RagIndexService,
    @InjectRepository(LcpRole)
    private readonly roleRepo: Repository<LcpRole>,
    @InjectRepository(LcpCompany)
    private readonly companyRepo: Repository<LcpCompany>,
  ) {}

  /**
   * Lists all OKF documents currently stored for the role.
   *
   * @throws {@link NotFoundException} when the role or company does not exist.
   */
  async listDocuments(roleId: UUID): Promise<DocumentSummary[]> {
    const { company, role } = await this.resolveRoleAndCompany(roleId);
    const objects = await this.minio.listKnowledgeFiles(
      company.slug,
      role.name,
    );
    return objects.map(toSummary);
  }

  /**
   * Stores a document and (re-)indexes it for RAG retrieval.
   *
   * If a document with the same `filename` already exists, it is overwritten
   * and its RAG chunks are replaced.
   *
   * @throws {@link NotFoundException} when the role or company does not exist.
   * @returns The {@link DocumentSummary} for the newly stored document.
   */
  async storeDocument(
    roleId: UUID,
    filename: string,
    content: Buffer,
  ): Promise<DocumentSummary> {
    const { company, role } = await this.resolveRoleAndCompany(roleId);
    const key = await this.minio.putKnowledgeFile(
      company.slug,
      role.name,
      filename,
      content,
    );
    await this.ragIndex.ingestDocument(
      company.id,
      role.id,
      key,
      content.toString('utf-8'),
      company.embeddingConfig,
    );
    return {
      key,
      name: filename,
      size: content.byteLength,
      lastModified: new Date().toISOString(),
    };
  }

  /**
   * Deletes documents by their MinIO object keys and removes their RAG chunks.
   *
   * Unknown keys are silently ignored — the operation is idempotent.
   *
   * @throws {@link NotFoundException} when the role or company does not exist.
   */
  async deleteDocuments(roleId: UUID, keys: string[]): Promise<void> {
    const { company, role } = await this.resolveRoleAndCompany(roleId);
    await Promise.all(
      keys.map(async (key) => {
        const filename = key.split('/').at(-1) ?? key;
        await this.minio.deleteKnowledgeFile(company.slug, role.name, filename);
        await this.ragIndex.removeDocument(role.id, key);
      }),
    );
  }

  private async resolveRoleAndCompany(
    roleId: UUID,
  ): Promise<{ role: LcpRole; company: LcpCompany }> {
    const role = await this.roleRepo.findOneBy({ id: roleId });
    if (!role) throw new NotFoundException(`Role ${roleId} not found`);
    const company = await this.companyRepo.findOneBy({ id: role.companyId });
    if (!company) {
      throw new NotFoundException(`Company ${role.companyId} not found`);
    }
    return { role, company };
  }
}

function toSummary(obj: StorageObject): DocumentSummary {
  return {
    key: obj.key,
    name: obj.name,
    size: obj.size,
    lastModified: obj.lastModified.toISOString(),
  };
}
