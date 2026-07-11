import type { UUID } from 'crypto';
import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Tracks the RAG-indexing state of a single knowledge *scope* — either a
 * role's `knowledge/{role_slug}/` folder or a company's `knowledge/shared/`
 * folder (when `roleId` is `null`).
 *
 * Used to keep embeddings in sync with storage (see
 * `apps/lcp-server/src/rag/knowledge-reindex.service.ts`):
 *
 * - `generation` is a monotonically increasing counter bumped on every change
 *   to the scope. A rebuild job carries the generation it was enqueued with;
 *   the worker skips a job whose generation is older than the current one, and
 *   aborts/re-enqueues if the generation changes mid-rebuild. This gives
 *   restart-on-change semantics without half-indexed state.
 * - `fingerprint` is a hash of the scope's storage listing recorded at the end
 *   of the last successful rebuild. The reconciliation poller compares it
 *   against a freshly computed fingerprint to detect out-of-band edits (e.g. a
 *   user editing directly in the MinIO console) and trigger a rebuild.
 *
 * Uniqueness is enforced per scope via two partial unique indexes because a
 * plain `UNIQUE(companyId, roleId)` treats `NULL` role ids as distinct in
 * Postgres, which would allow duplicate shared rows.
 */
@Entity()
@Index('UQ_knowledge_index_state_role', ['companyId', 'roleId'], {
  unique: true,
  where: '"roleId" IS NOT NULL',
})
@Index('UQ_knowledge_index_state_shared', ['companyId'], {
  unique: true,
  where: '"roleId" IS NULL',
})
export class KnowledgeIndexState {
  /**
   * Auto-generated primary key.
   * @format uuid
   */
  @PrimaryGeneratedColumn('uuid')
  id!: UUID;

  /**
   * The company that owns this knowledge scope.
   * @format uuid
   */
  @Column({ type: 'varchar' })
  companyId!: UUID;

  /**
   * The role whose knowledge folder this scope tracks, or `null` for the
   * company-wide `knowledge/shared/` scope.
   * @format uuid
   */
  @Column({ type: 'varchar', nullable: true })
  roleId!: UUID | null;

  /** Monotonic change counter — bumped on every trigger, carried by rebuild jobs. */
  @Column({ type: 'int', default: 0 })
  generation!: number;

  /** Hash of the storage listing indexed by the last successful rebuild, or `null` if never indexed. */
  @Column({ type: 'text', nullable: true })
  fingerprint!: string | null;

  /** When this scope's state last changed. */
  @UpdateDateColumn()
  updatedAt!: Date;
}
