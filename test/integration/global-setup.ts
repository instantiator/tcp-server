import { assertMinioReachable } from '../../libs/tcp-shared/src/storage/minio-reachability';
import { assertRedisReachable } from '../../libs/tcp-shared/src/redis/redis-reachability';
import { rememberComposeEnv } from '../support/compose-env-handle';
import { startComposeTier } from '../support/testcontainers-env';

/**
 * Jest global setup for the integration tier. Starts the dependency containers
 * (Postgres, Redis, MinIO, and the stub-llm service) once for the whole run via
 * testcontainers, then exposes their connection details as env vars for the
 * spec files. Torn down by the matching global-teardown.
 *
 * `assertRedisReachable`/`assertMinioReachable` are imported by relative path
 * rather than from `@tcp/shared` because Jest's moduleNameMapper is not
 * reliably applied to globalSetup modules.
 */
export default async function globalSetup(): Promise<void> {
  const { environment, env } = await startComposeTier({
    tier: 'integration',
    services: ['postgres', 'redis', 'minio', 'stub-llm'],
    profiles: ['integration'],
    // Generous: stub-llm is built from a Dockerfile, slow on a cold cache.
    startupTimeoutMs: 120_000,
  });

  // Defence in depth: confirm Redis really answers before any spec (or the
  // app it boots) tries to use it, so a failure surfaces here with a clear
  // message rather than deep inside a test.
  await assertRedisReachable(env.REDIS_URL);
  // Same defence for MinIO: its healthcheck can pass slightly before the S3
  // API actually serves requests, and MinioStorageAdapter only warns (not
  // throws) when it can't verify its bucket at startup — without this, the
  // first storage write in a spec fails with a raw, unhandled 500 instead of
  // a clear "MinIO is not reachable" error here.
  await assertMinioReachable(
    env.MINIO_ENDPOINT,
    process.env.MINIO_ACCESS_KEY ?? '',
    process.env.MINIO_SECRET_KEY ?? '',
  );

  rememberComposeEnv(environment);
}
