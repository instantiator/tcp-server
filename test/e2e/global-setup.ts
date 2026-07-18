import { assertRedisReachable } from '../../libs/lcp-shared/src/redis/redis-reachability';
import { rememberComposeEnv } from '../support/compose-env-handle';
import { startComposeTier } from '../support/testcontainers-env';

/**
 * Jest global setup for the e2e tier. Starts the dependency containers
 * (Postgres, Redis, MinIO) once for the whole run via testcontainers and
 * exposes their connection details as env vars. Zitadel is not needed — auth
 * is mocked (jwks-rsa) — so no `auth` profile is started. Torn down by the
 * matching global-teardown.
 *
 * `assertRedisReachable` is imported by relative path rather than from
 * `@lcp/shared` because Jest's moduleNameMapper is not reliably applied to
 * globalSetup modules.
 */
export default async function globalSetup(): Promise<void> {
  const { environment, env } = await startComposeTier({
    tier: 'e2e',
    services: ['postgres', 'redis', 'minio'],
    startupTimeoutMs: 90_000,
  });

  // Defence in depth: the e2e apps boot in-process and enqueue BullMQ jobs, so
  // confirm Redis really answers before any spec loads. This is what makes the
  // old "running e2e directly HANGS on an unreachable Redis" footgun impossible.
  await assertRedisReachable(env.REDIS_URL);

  rememberComposeEnv(environment);
}
