import { AuditEventType, TcpCompany } from '@tcp/shared';
import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { KnowledgeReindexService } from '../rag/knowledge-reindex.service';
import { Originators } from './storage.service';

const DEFAULT_ORIGINATORS: Originators = {
  user: null,
  agent: null,
  task: null,
};

/**
 * What happens *around* a successful storage operation: the audit trail, and
 * keeping RAG embeddings in step with the bytes on disk.
 *
 * Neither may ever turn a successful storage operation into a failure for the
 * caller — by the time these run the write has already landed — so both
 * swallow their own errors with a visible warning instead of throwing.
 */
@Injectable()
export class StorageSideEffects {
  private readonly logger = new Logger(StorageSideEffects.name);

  constructor(
    private readonly audit: AuditService,
    @InjectRepository(TcpCompany)
    private readonly companyRepo: Repository<TcpCompany>,
    @Inject(forwardRef(() => KnowledgeReindexService))
    private readonly reindex: KnowledgeReindexService,
  ) {}

  /**
   * Records a storage audit event with a real `companyId` resolved from the
   * key's leading slug segment. Skips (with a visible warning) rather than
   * writing a doomed nil-company-id event when no real company can be
   * resolved — see docs/prompts/009.4 §Risks (the previous nil-UUID
   * placeholder silently failed the FK constraint on every call).
   */
  async recordAudit(
    tool: string,
    path: string,
    companySlug: string,
    originators: Originators | undefined,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      const company = await this.companyRepo.findOneBy({ slug: companySlug });
      if (!company) {
        this.logger.warn(
          `Skipping storage audit for "${tool}" on ${path}: no company found for slug "${companySlug}"`,
        );
        return;
      }
      const resolvedOriginators = originators ?? DEFAULT_ORIGINATORS;
      await this.audit.record(
        company.id,
        'storage',
        resolvedOriginators.agent as UUID | null,
        AuditEventType.ToolCall,
        { tool, path, originators: resolvedOriginators, ...extra },
      );
    } catch (err) {
      this.logger.warn(
        `Storage audit write failed for "${tool}" on ${path}: ${String(err instanceof Error ? err.message : err)}`,
      );
    }
  }

  /**
   * Enqueues a RAG rebuild for any affected key that falls under a
   * `knowledge/` folder — the single chokepoint that keeps embeddings in sync
   * with storage, whoever wrote the file (user, agent, or CLI). A no-op for
   * non-knowledge keys ({@link KnowledgeReindexService.bumpByKey} filters
   * them).
   */
  async triggerReindex(...keys: string[]): Promise<void> {
    for (const key of keys) {
      try {
        await this.reindex.bumpByKey(key);
      } catch (err) {
        this.logger.warn(
          `Knowledge reindex trigger failed for ${key}: ${String(err instanceof Error ? err.message : err)}`,
        );
      }
    }
  }
}
