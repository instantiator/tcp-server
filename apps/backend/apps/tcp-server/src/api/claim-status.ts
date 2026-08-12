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
  // TypeScript defers conditional types (which QueryDeepPartialEntity<T> is,
  // internally) until a generic type parameter is substituted with a
  // concrete type, so it can never structurally verify this object against
  // QueryDeepPartialEntity<T> inside claimStatus's own body — only at each
  // call site, where T is concrete, does real checking happen (enforced by
  // the `extra` parameter's type above). One assertion is the accepted
  // workaround for this TypeORM + generics limitation.
  const updateSet = { status: to, ...extra } as QueryDeepPartialEntity<T>;
  const result = await repo
    .createQueryBuilder()
    .update<T>(repo.target)
    .set(updateSet)
    .where('id = :id', { id })
    .andWhere('status = :from', { from })
    .execute();
  return result.affected ?? 0;
}
