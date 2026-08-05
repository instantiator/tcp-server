import { assertMinioReachable } from '../../../../libs/tcp-shared/src/storage/minio-reachability';
import { assertRedisReachable } from '../../../../libs/tcp-shared/src/redis/redis-reachability';
import { rememberComposeEnv } from '../support/compose-env-handle';
import { migrateDatabase } from '../support/migrate-database';
import { startComposeTier } from '../support/testcontainers-env';

/**
 * Jest global setup for the e2e tier. Starts the dependency containers
 * (Postgres, Redis, MinIO, and — on the `integration` profile — the stub-llm
 * service) once for the whole run via testcontainers and exposes their
 * connection details as env vars. Zitadel is not needed — auth is mocked
 * (jwks-rsa) — so no `auth` profile is started. Torn down by the matching
 * global-teardown.
 *
 * stub-llm is provisioned tier-wide (not per-spec) so specs that need a real
 * agent-loop run against it (e.g. `tcp-agent/agent-loop-interactions.e2e-spec.ts`)
 * can just read `STUB_LLM_URL` — the container is started once regardless of
 * how many specs use it, same as the integration tier already does.
 *
 * `assertRedisReachable`/`assertMinioReachable` are imported by relative path
 * rather than from `@tcp/shared` because Jest's moduleNameMapper is not
 * reliably applied to globalSetup modules.
 */
export default async function globalSetup(): Promise<void> {
  const { environment, env } = await startComposeTier({
    tier: 'e2e',
    services: ['postgres', 'redis', 'minio', 'stub-llm'],
    profiles: ['integration'],
    startupTimeoutMs: 90_000,
  });

  // Defence in depth: the e2e apps boot in-process and enqueue BullMQ jobs, so
  // confirm Redis really answers before any spec loads. This is what makes the
  // old "running e2e directly HANGS on an unreachable Redis" footgun impossible.
  await assertRedisReachable(env.REDIS_URL);
  // Same defence for MinIO: its container healthcheck can pass slightly
  // before the S3 API actually serves requests, and MinioStorageAdapter only
  // warns (not throws) when it can't verify its bucket at startup — without
  // this, the first storage write in a spec fails with a raw, unhandled 500
  // instead of a clear "MinIO is not reachable" error here.
  await assertMinioReachable(
    env.MINIO_ENDPOINT,
    process.env.MINIO_ACCESS_KEY ?? '',
    process.env.MINIO_SECRET_KEY ?? '',
  );

  rememberComposeEnv(environment);

  // Every spec in the tier needs a migrated schema before it runs — see
  // migrateDatabase for why no spec is allowed to build one itself.
  await migrateDatabase(env.DATABASE_URL);
}
