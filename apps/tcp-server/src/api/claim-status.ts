import { UUID } from 'crypto';
import { ObjectLiteral, QueryDeepPartialEntity, Repository } from 'typeorm';

/**
 * Atomically flips an entity's `status` column from `from` to `to`, optionally
 * setting other columns (e.g. `failureReason`) in the same update.
 * Returns the number of rows affected — `0` means another writer already
 * moved it off `from`, so the caller lost the race and should back off.
 */
export async function claimStatus<
  T extends ObjectLiteral & { id: UUID; status: string },
>(
  repo: Repository<T>,
  id: UUID,
  from: T['status'],
  to: T['status'],
  extra?: Partial<T>,
): Promise<number> {
  const result = await repo
    .createQueryBuilder()
    .update(repo.target)
    // TypeORM's QueryDeepPartialEntity<T> doesn't structurally match a bare
    // generic T, even though `{ status, ...extra }` is valid for every
    // caller's entity.
    .set({ status: to, ...extra } as unknown as QueryDeepPartialEntity<T>)
    .where('id = :id', { id })
    .andWhere('status = :from', { from })
    .execute();
  return result.affected ?? 0;
}
