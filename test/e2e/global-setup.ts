import { DataSource } from 'typeorm';
import { MIGRATIONS } from '../../apps/lcp-server/src/migrations-list';
import {
  AuditEvent,
  CompanyUser,
  Conversation,
  ConversationMessage,
  EpisodicMemory,
  KnowledgeChunk,
  KnowledgeIndexState,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  TcpTask,
  PendingConsultation,
} from '../../libs/lcp-shared/src/models';
import { assertMinioReachable } from '../../libs/lcp-shared/src/storage/minio-reachability';
import { assertRedisReachable } from '../../libs/lcp-shared/src/redis/redis-reachability';
import { rememberComposeEnv } from '../support/compose-env-handle';
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
 * agent-loop run against it (e.g. `lcp-agent/agent-loop-interactions.e2e-spec.ts`)
 * can just read `STUB_LLM_URL` — the container is started once regardless of
 * how many specs use it, same as the integration tier already does.
 *
 * `assertRedisReachable`/`assertMinioReachable` are imported by relative path
 * rather than from `@lcp/shared` because Jest's moduleNameMapper is not
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

  // Every e2e spec in the tier needs a migrated schema, but only specs that
  // boot lcp-server's own AppModule get one as an incidental side effect of
  // that app's startup (migrationsRun: true, see makeTypeOrmConfig). Specs
  // that only ever boot another app's AppModule — e.g.
  // test/e2e/lcp-mcp-memory/*.e2e-spec.ts — never trigger that, and per the
  // single-migration-owner design (see apps/lcp-server/src/migrations-list.ts)
  // never should. Running lcp-server's migrations once here, against the
  // shared Postgres container, gives every spec a real schema regardless of
  // which app it boots or what order specs run in.
  //
  // `entities` must be passed alongside `migrations`, not omitted: TypeORM's
  // PostgresDriver auto-creates the `uuid-ossp` extension during connect,
  // but only when it detects a `uuid`-generated column in entity metadata
  // (PostgresDriver.js's post-connect setup). Without entities, several
  // migrations' raw `DEFAULT uuid_generate_v4()` SQL fails outright — the
  // same entity list `AppModule` registers is reused here for that reason,
  // not because this DataSource ever reads/writes through them.
  const migrationDataSource = new DataSource({
    type: 'postgres',
    url: env.DATABASE_URL,
    entities: [
      TcpCompany,
      TcpRole,
      TcpAgent,
      TcpTask,
      TcpAssignment,
      AuditEvent,
      KnowledgeChunk,
      KnowledgeIndexState,
      EpisodicMemory,
      CompanyUser,
      Conversation,
      ConversationMessage,
      PendingConsultation,
    ],
    migrations: MIGRATIONS,
  });
  await migrationDataSource.initialize();
  await migrationDataSource.runMigrations();
  await migrationDataSource.destroy();
}
