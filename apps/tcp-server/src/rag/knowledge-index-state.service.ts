import { createHash, UUID } from 'crypto';
import { KnowledgeIndexState } from '@tcp/shared';
import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { StorageObject } from '../storage/storage.service';

/**
 * Deterministic fingerprint of a storage listing: sorted `key:etag:size:
 * lastModified` lines, SHA-256 hashed. Any add/remove/edit changes the hash,
 * so the poller can detect out-of-band drift without reading file contents.
 */
export function fingerprintListing(files: StorageObject[]): string {
  const lines = files
    .map(
      (f) =>
        `${f.key}:${f.etag ?? ''}:${f.size}:${f.lastModified.toISOString()}`,
    )
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * The per-scope {@link KnowledgeIndexState} row: the generation counter that
 * makes reindexing restart-on-change, the fingerprint of the listing last
 * indexed, and the last failure seen.
 *
 * The generation is the whole mechanism {@link KnowledgeReindexService} relies
 * on to collapse a burst of writes into one up-to-date rebuild, so every read
 * and write of it goes through here.
 */
@Injectable()
export class KnowledgeIndexStateService {
  constructor(
    @InjectRepository(KnowledgeIndexState)
    private readonly stateRepo: Repository<KnowledgeIndexState>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /** Atomic generation increment via upsert, targeting the scope's partial unique index. */
  async increment(companyId: UUID, roleId: UUID | null): Promise<number> {
    const rows =
      roleId === null
        ? await this.dataSource.query<{ generation: number }[]>(
            `INSERT INTO knowledge_index_state ("companyId", "roleId", generation, "updatedAt")
             VALUES ($1, NULL, 1, now())
             ON CONFLICT ("companyId") WHERE "roleId" IS NULL
             DO UPDATE SET generation = knowledge_index_state.generation + 1, "updatedAt" = now()
             RETURNING generation`,
            [companyId],
          )
        : await this.dataSource.query<{ generation: number }[]>(
            `INSERT INTO knowledge_index_state ("companyId", "roleId", generation, "updatedAt")
             VALUES ($1, $2, 1, now())
             ON CONFLICT ("companyId", "roleId") WHERE "roleId" IS NOT NULL
             DO UPDATE SET generation = knowledge_index_state.generation + 1, "updatedAt" = now()
             RETURNING generation`,
            [companyId, roleId],
          );
    return Number(rows[0].generation);
  }

  /** Current generation for a scope, or 0 if the scope has never been bumped. */
  async current(companyId: UUID, roleId: UUID | null): Promise<number> {
    const state = await this.find(companyId, roleId);
    return state?.generation ?? 0;
  }

  /** The scope's state row, or `null` if it has never been indexed. */
  find(
    companyId: UUID,
    roleId: UUID | null,
  ): Promise<KnowledgeIndexState | null> {
    return this.stateRepo.findOne({
      where: { companyId, roleId: roleId ?? IsNull() },
    });
  }

  /**
   * Records the fingerprint of a completed rebuild, clearing any stale error
   * from an earlier failed attempt at this scope.
   *
   * Guarded on generation so a concurrent bump's state is not clobbered by a
   * run it has already superseded.
   */
  async recordIndexed(
    companyId: UUID,
    roleId: UUID | null,
    generation: number,
    fingerprint: string,
  ): Promise<void> {
    await this.stateRepo.update(
      { companyId, roleId: roleId ?? IsNull(), generation },
      {
        fingerprint,
        lastError: null,
        // lastErrorAt is Date | undefined (not | null) — see
        // KnowledgeIndexState — so clearing needs a raw SQL literal rather
        // than assigning null directly (matches TcpAgent.pausedAt's clear
        // pattern in AgentOrchestrationService).
        lastErrorAt: () => 'NULL',
      },
    );
  }

  /**
   * Records why a rebuild failed, so `get-knowledge-index-status` and the
   * knowledge endpoints' `X-Tcp-Warnings` can surface it — a silent BullMQ job
   * failure would otherwise leave the index stuck at zero chunks with no
   * visible explanation. Generation-guarded for the same reason as
   * {@link recordIndexed}.
   */
  async recordFailure(
    companyId: UUID,
    roleId: UUID | null,
    generation: number,
    message: string,
  ): Promise<void> {
    await this.stateRepo.update(
      { companyId, roleId: roleId ?? IsNull(), generation },
      { lastError: message, lastErrorAt: new Date() },
    );
  }
}
