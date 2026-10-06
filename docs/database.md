# Database

## Configuration

The database is PostgreSQL 16 with the pgvector extension. Connection details come from environment variables validated on startup.

| Variable            | Example                                      | Description                |
| ------------------- | -------------------------------------------- | -------------------------- |
| `DATABASE_URL`      | `postgres://tcp:password@localhost:5432/tcp` | Full connection string     |
| `POSTGRES_USER`     | `tcp`                                        | Set in Docker Compose only |
| `POSTGRES_PASSWORD` | _(see `.env`)_                               | Set in Docker Compose only |
| `POSTGRES_DB`       | `tcp`                                        | Set in Docker Compose only |

Local credentials live in `.env` (not committed). See `.env.example` for the required keys.

## Which services connect

| Service              | Connects | Notes                                                                  |
| -------------------- | -------- | ---------------------------------------------------------------------- |
| tcp-server           | Yes      | Owns migrations; reads and writes all entities                         |
| tcp-agent            | Yes      | Reads roles/companies; writes `TcpAgent`; migrations run by tcp-server |
| tcp-mcp-memory       | Yes      | Reads/writes `EpisodicMemory`; reads `TcpCompany` for embedding config |
| tcp-mcp-storage      | No       | Uses MinIO only                                                        |
| tcp-mcp-interactions | No       | Delegates all DB writes to tcp-server via internal HTTP                |

## SQLite fallback for tests

When `DATABASE_URL` is absent or starts with `sqlite`, the TypeORM factory (`makeTypeOrmConfig`) returns a better-sqlite3 in-memory database with `synchronize: true`. This is used automatically by:

- Unit tests (`.spec.ts`) — always in-memory
- E2E tests — in-memory unless `DATABASE_URL` points to a real Postgres instance

The SQLite fallback does not run migrations and does not support pgvector or JSONB. Tests that depend on those features must run against a real database (see `./scripts/run-integration-tests.sh`).

## Migrations

Migrations run automatically on tcp-server startup when connecting to Postgres (`migrationsRun: true`). tcp-agent and tcp-mcp-memory set `migrationsRun: false` — they assume tcp-server has already applied all migrations.

The integration and e2e test tiers apply the same ownership rule: each tier's Jest `global-setup.ts` migrates the shared Postgres container once (`apps/backend/test/support/migrate-database.ts`) before any spec runs, so no spec builds or owns the schema. A spec must not point a `synchronize: true` connection at the tier's `DATABASE_URL` — that leaves the database carrying TypeORM's generated constraint names and unmigratable for whichever spec boots a real `AppModule` next.

See [db-migrations.md](db-migrations.md) for how to generate, review, register
and run one — including the hand-registration step in `migrations-list.ts` that
the TypeORM CLI's glob will otherwise mask.

## Timestamp storage convention

All timestamps are stored as UTC, unambiguously. Two rules make this work across both Postgres (production) and SQLite (tests):

1. **Entity decorators stay untyped.** `@CreateDateColumn()`/`@UpdateDateColumn()`/`@Column()` on a `Date`-typed field never specify an explicit `type:` (no `'timestamptz'`, no `'datetime'`). This is deliberate — an explicit type string is dialect-specific and breaks one driver or the other (see `[[feedback-typeorm-cross-db-dates]]`). TypeORM's SQLite driver stores these as ISO-8601 text regardless of what a Postgres-specific type string would say.
2. **Postgres column types are fixed by hand-written migration, not by the entity.** Every `Date` column is `timestamptz` in Postgres (see `TimestamptzConsistency` migration). Because the entities are deliberately untyped, `npm run migration:generate` will report these columns as "drift" forever — that's expected, not a bug to fix; migration generation here is diagnostic-only (`scripts/check-migrations.sh`), not a gate.

One column type actually regressed once already: `tcp_agent.createdAt`/`updatedAt` and `audit_event.timestamp` were `timestamptz` in the migration that first created them, then got reset to naive `timestamp` by a later, unrelated-looking migration — almost certainly an auto-generated migration reconciling drift back to the untyped entity's Postgres default. `TimestamptzConsistency1783357408216` fixes this (and every other naive column) directly in Postgres, without touching the entities, so the same regression can't happen again via `migration:generate`.

**Display and LLM-prompt localization:** storage is always UTC; presentation is not. `TcpCompany.timezone` (an IANA name, e.g. `Europe/London`) is used only when _displaying_ a timestamp (CLI output) or when giving an agent a company-local time alongside its UTC anchor (`{{localDatetime}}` in a rendered `systemPromptTemplate`, built by `buildPromptDateVars` in `@tcp/shared`). The LLM is always also given the explicit UTC time (`{{datetime}}`) — the local time is additional context, never a replacement.

**MinIO:** object metadata (`LastModified`) is already an S3-API-guaranteed UTC instant, independent of any container timezone configuration — no `TZ` env var is set for the `minio` service in `docker-compose.yml`, and none is needed. No change was required here.

## Concurrent access strategy

### Optimistic locking (`TcpAgent`, `Conversation`, `PendingConsultation`)

These entities are written by multiple concurrent callers (BullMQ workers, HTTP endpoints, background tasks). They extend `VersionedEntity`, which adds a `version: number` column via TypeORM's `@VersionColumn()`.

On each `save()`, TypeORM increments `version` and verifies the value in the `WHERE` clause. If another writer has already incremented it, TypeORM throws `OptimisticLockVersionMismatchError`. Callers should wrap writes in `withOptimisticRetry` (imported from `@tcp/shared`):

```typescript
import { withOptimisticRetry } from '@tcp/shared';

await withOptimisticRetry(async () => {
  const agent = await agentRepo.findOneByOrFail({ id: agentId });
  agent.status = AgentStatus.Completed;
  await agentRepo.save(agent);
});
```

### Atomic increment (`TcpRole.queryIndex`)

`queryIndex` is incremented via raw SQL `UPDATE tcp_role SET "queryIndex" = "queryIndex" + 1 WHERE id = $1 RETURNING "queryIndex"`. This is atomic at the database level and does not require optimistic locking.

### Append-only (`AuditEvent`, `TokenUsage`)

Audit events are INSERT-only. No locking needed.

`token_usage` (000.02) is INSERT-only for the same reason, and for one more:
summing raw rows at read time avoids an upsert against a composite, partially
nullable key (`provider` + `companyId` + `taskId` + window) that behaves
differently on Postgres and SQLite. A cap check and `GET /api/spend` /
`GET /api/company/:id/spend` both `SUM` over the relevant window rather than
reading a running total anywhere — see [spend-caps.md](spend-caps.md) and
[ADR-031](ADRs/ADR-031-spend-tracking-and-notifications.md). `spend_cap_state`
(one row per provider) and `notification` (application-wide, no `companyId`)
are both updated in place, not append-only. `tcp_task` gained one column,
`spendCapExempt`, set when a task is explicitly started or resumed while a
cap is reached.

Storage-tool audit events nest an `originators: { user: string | null; agent: string | null; task: string | null }` object inside `payload`, tracking who requested the action — `user` for direct JWT-authenticated calls (`POST /api/storage`, role document uploads), `agent` for MCP-tool-initiated calls, `task` reserved for a future task concept (always `null` today). No schema change: `payload` is already `jsonb`.

### LangGraph checkpoint store

LangGraph's `PostgresSaver` manages its own internal tables. Concurrent `updateState()` calls (e.g. during context compaction) may race; this is a known limitation not addressable via TypeORM `@VersionColumn`. Avoid triggering concurrent state updates for the same `thread_id`.

## Health checks and cross-service communication

Each service's `/health` endpoint checks only its own direct infrastructure dependencies (DB, Redis, MinIO). No service probes another service's health endpoint — doing so would create circular dependency chains. A service with no direct infrastructure dependency of its own (`tcp-mcp-interactions`; `tcp-mcp-storage`, whose storage access moved behind `tcp-server`'s API) returns a static `{status:'ok'}` instead, relying entirely on Docker Compose's `depends_on` ordering below.

Cross-service startup ordering is handled by Docker Compose `depends_on: condition: service_healthy`. Cross-service communication health is validated end-to-end by the smoke test suite (`./scripts/run-smoke-tests.sh`).

## Starting the database only

```bash
docker compose up postgres
```

## Manual querying

Connect with psql:

```bash
psql postgres://tcp:<POSTGRES_PASSWORD>@localhost:5432/tcp
```

Submit a query directly using docker:

```bash
docker exec tcp-dev-postgres-1 psql -U tcp -d tcp -c \
  "SELECT timestamp, \"eventType\", \"agentId\", payload FROM audit_event ORDER BY timestamp DESC LIMIT 20;"
```

Connect with a GUI tool (TablePlus, pgAdmin): host `localhost`, port `5432`, database `tcp`, user `tcp`, password from `.env`.

### Useful developer queries

```sql
-- Agent loops run in the last hour
SELECT id, status, "createdAt", LEFT("initialPrompt", 80) AS prompt
FROM tcp_agent
WHERE "createdAt" > NOW() - INTERVAL '1 hour'
ORDER BY "createdAt" DESC;

-- Currently running agents
SELECT id, "companyId", "roleId", status, "createdAt"
FROM tcp_agent
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

-- LLM token usage for a run, read off the audit payload directly
SELECT timestamp,
       (payload->'usage'->>'inputTokens')::int  AS in_tokens,
       (payload->'usage'->>'outputTokens')::int AS out_tokens
FROM audit_event
WHERE "agentId" = '<uuid>'
  AND "eventType" = 'llm_response'
ORDER BY timestamp ASC;

-- The same figures from token_usage (000.02), the recorded copy cap checks and
-- GET /api/spend read from
SELECT "createdAt", provider, model, "inputTokens", "outputTokens"
FROM token_usage
WHERE "agentId" = '<uuid>'
ORDER BY "createdAt" ASC;

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
