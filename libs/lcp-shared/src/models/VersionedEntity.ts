import { VersionColumn } from 'typeorm';

/**
 * Abstract base for entities that require optimistic concurrency control.
 *
 * TypeORM increments `version` on every `save()` and throws
 * `OptimisticLockVersionMismatchError` when a stale version is detected,
 * preventing lost updates under concurrent writes. Callers should wrap
 * writes in {@link withOptimisticRetry}.
 *
 * Apply to entities with concurrent write patterns: multiple BullMQ workers,
 * HTTP endpoints, or background tasks that can race on the same row.
 */
export abstract class VersionedEntity {
  @VersionColumn()
  version!: number;
}
