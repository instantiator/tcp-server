# Database

## Configuration

The database is PostgreSQL 16 with the pgvector extension. Connection details come from environment variables validated on startup.

| Variable            | Example                                      | Description                |
| ------------------- | -------------------------------------------- | -------------------------- |
| `DATABASE_URL`      | `postgres://lcp:password@localhost:5432/lcp` | Full connection string     |
| `POSTGRES_USER`     | `lcp`                                        | Set in Docker Compose only |
| `POSTGRES_PASSWORD` | _(see `.env`)_                               | Set in Docker Compose only |
| `POSTGRES_DB`       | `lcp`                                        | Set in Docker Compose only |

Local credentials live in `.env` (not committed). See `.env.example` for the required keys.

## Which services connect

| Service              | Connects | Notes                                                                  |
| -------------------- | -------- | ---------------------------------------------------------------------- |
| lcp-server           | Yes      | Owns migrations; reads and writes all entities                         |
| lcp-agent            | Yes      | Reads roles/companies; writes `LcpAgent`; migrations run by lcp-server |
| lcp-mcp-memory       | Yes      | Reads/writes `EpisodicMemory`; reads `LcpCompany` for embedding config |
| lcp-mcp-storage      | No       | Uses MinIO only                                                        |
| lcp-mcp-interactions | No       | Delegates all DB writes to lcp-server via internal HTTP                |

## SQLite fallback for tests

When `DATABASE_URL` is absent or starts with `sqlite`, the TypeORM factory (`makeTypeOrmConfig`) returns a better-sqlite3 in-memory database with `synchronize: true`. This is used automatically by:

- Unit tests (`.spec.ts`) — always in-memory
- E2E tests — in-memory unless `DATABASE_URL` points to a real Postgres instance

The SQLite fallback does not run migrations and does not support pgvector or JSONB. Tests that depend on those features must run against a real database (see `./scripts/run-integration-tests.sh`).

## Migrations

Migrations run automatically on lcp-server startup when connecting to Postgres (`migrationsRun: true`). lcp-agent and lcp-mcp-memory set `migrationsRun: false` — they assume lcp-server has already applied all migrations.

Generate a new migration after changing entities:

```bash
npm run migration:generate -- apps/lcp-server/src/migrations/DescriptiveName
npm run migration:run
```

Revert the most recent migration:

```bash
npm run migration:revert
```

## Timestamp storage convention

All timestamps are stored as UTC, unambiguously. Two rules make this work across both Postgres (production) and SQLite (tests):

1. **Entity decorators stay untyped.** `@CreateDateColumn()`/`@UpdateDateColumn()`/`@Column()` on a `Date`-typed field never specify an explicit `type:` (no `'timestamptz'`, no `'datetime'`). This is deliberate — an explicit type string is dialect-specific and breaks one driver or the other (see `[[feedback-typeorm-cross-db-dates]]`). TypeORM's SQLite driver stores these as ISO-8601 text regardless of what a Postgres-specific type string would say.
2. **Postgres column types are fixed by hand-written migration, not by the entity.** Every `Date` column is `timestamptz` in Postgres (see `TimestamptzConsistency` migration). Because the entities are deliberately untyped, `npm run migration:generate` will report these columns as "drift" forever — that's expected, not a bug to fix; migration generation here is diagnostic-only (`scripts/check-migrations.sh`), not a gate.

One column type actually regressed once already: `lcp_agent.createdAt`/`updatedAt` and `audit_event.timestamp` were `timestamptz` in the migration that first created them, then got reset to naive `timestamp` by a later, unrelated-looking migration — almost certainly an auto-generated migration reconciling drift back to the untyped entity's Postgres default. `TimestamptzConsistency1783357408216` fixes this (and every other naive column) directly in Postgres, without touching the entities, so the same regression can't happen again via `migration:generate`.

**Display and LLM-prompt localization:** storage is always UTC; presentation is not. `LcpCompany.timezone` (an IANA name, e.g. `Europe/London`) is used only when _displaying_ a timestamp (CLI output) or when giving an agent a company-local time alongside its UTC anchor (`{{localDatetime}}` in a rendered `systemPromptTemplate`, built by `buildPromptDateVars` in `@lcp/shared`). The LLM is always also given the explicit UTC time (`{{datetime}}`) — the local time is additional context, never a replacement.

**MinIO:** object metadata (`LastModified`) is already an S3-API-guaranteed UTC instant, independent of any container timezone configuration — no `TZ` env var is set for the `minio` service in `docker-compose.yml`, and none is needed. No change was required here.

## Concurrent access strategy

### Optimistic locking (`LcpAgent`, `Conversation`, `PendingConsultation`)

These entities are written by multiple concurrent callers (BullMQ workers, HTTP endpoints, background tasks). They extend `VersionedEntity`, which adds a `version: number` column via TypeORM's `@VersionColumn()`.

On each `save()`, TypeORM increments `version` and verifies the value in the `WHERE` clause. If another writer has already incremented it, TypeORM throws `OptimisticLockVersionMismatchError`. Callers should wrap writes in `withOptimisticRetry` (imported from `@lcp/shared`):

```typescript
import { withOptimisticRetry } from '@lcp/shared';

await withOptimisticRetry(async () => {
  const agent = await agentRepo.findOneByOrFail({ id: agentId });
  agent.status = AgentStatus.Completed;
  await agentRepo.save(agent);
});
```

### Atomic increment (`LcpRole.queryIndex`)

`queryIndex` is incremented via raw SQL `UPDATE lcp_role SET "queryIndex" = "queryIndex" + 1 WHERE id = $1 RETURNING "queryIndex"`. This is atomic at the database level and does not require optimistic locking.

### Append-only (`AuditEvent`)

Audit events are INSERT-only. No locking needed.

### LangGraph checkpoint store

LangGraph's `PostgresSaver` manages its own internal tables. Concurrent `updateState()` calls (e.g. during context compaction) may race; this is a known limitation not addressable via TypeORM `@VersionColumn`. Avoid triggering concurrent state updates for the same `thread_id`.

## Health checks and cross-service communication

Each service's `/health` endpoint checks only its own direct infrastructure dependencies (DB, Redis, MinIO). No service probes another service's health endpoint — doing so would create circular dependency chains.

Cross-service startup ordering is handled by Docker Compose `depends_on: condition: service_healthy`. Cross-service communication health is validated end-to-end by the smoke test suite (`./scripts/run-smoke-tests.sh`).

## Starting the database only

```bash
docker compose up postgres
```

## Manual querying

Connect with psql:

```bash
psql postgres://lcp:<POSTGRES_PASSWORD>@localhost:5432/lcp
```

Submit a query directly using docker:

```bash
docker exec lcp-dev-postgres-1 psql -U lcp -d lcp -c \
  "SELECT timestamp, \"eventType\", \"agentId\", payload FROM audit_event ORDER BY timestamp DESC LIMIT 20;"
```

Connect with a GUI tool (TablePlus, pgAdmin): host `localhost`, port `5432`, database `lcp`, user `lcp`, password from `.env`.

### Useful developer queries

```sql
-- Agent loops run in the last hour
SELECT id, status, "createdAt", LEFT("initialPrompt", 80) AS prompt
FROM lcp_agent
WHERE "createdAt" > NOW() - INTERVAL '1 hour'
ORDER BY "createdAt" DESC;

-- Currently running agents
SELECT id, "companyId", "roleId", status, "createdAt"
FROM lcp_agent
WHERE status = 'running';

-- Full audit trail for a specific agent run (chronological)
SELECT timestamp, "eventType", payload
FROM audit_event
WHERE "agentId" = '<uuid>'
ORDER BY timestamp ASC;

-- Completion summary for an agent run
SELECT payload->>'summary'   AS summary,
       payload->'actions'    AS actions
FROM audit_event
WHERE "agentId" = '<uuid>'
  AND "eventType" = 'agent_loop_completion'
LIMIT 1;

-- LLM token usage for a run
SELECT timestamp,
       (payload->'usage'->>'input_tokens')::int  AS in_tokens,
       (payload->'usage'->>'output_tokens')::int AS out_tokens
FROM audit_event
WHERE "agentId" = '<uuid>'
  AND "eventType" = 'llm_response'
ORDER BY timestamp ASC;

-- Open conversations awaiting user reply
SELECT slug, question, "roleName", "createdAt"
FROM conversation
WHERE status = 'awaiting_user'
ORDER BY "createdAt" ASC;

-- All audit events for a company in the last 24 hours
SELECT timestamp, "eventType", "agentId", payload
FROM audit_event
WHERE "companyId" = '<uuid>'
  AND timestamp > NOW() - INTERVAL '24 hours'
ORDER BY timestamp DESC;
```
