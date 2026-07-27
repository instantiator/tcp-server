import { OptimisticLockVersionMismatchError } from 'typeorm';

/**
 * Retries `fn` up to `maxRetries` times on {@link OptimisticLockVersionMismatchError}.
 *
 * `fn` must be a full re-entrant unit: load → mutate → save. Each retry
 * re-executes the closure so the latest entity version is always fetched
 * before the next save attempt.
 *
 * Any other error, or a version mismatch after `maxRetries` exhausted, is
 * rethrown without wrapping.
 */
export async function withOptimisticRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (
        err instanceof OptimisticLockVersionMismatchError &&
        attempt < maxRetries
      ) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
