# ADR-004: Database Strategy

Status: Proposed

## Context

`tcp-server` currently uses `better-sqlite3` in-memory via TypeORM, which is adequate for development and unit testing but unsuitable for production. The full system needs a database that supports:

1. **Relational data** — companies, users, roles, tasks, task steps, agent runs
2. **Vector embeddings** — role memories and RAG knowledge base retrieval (see [ADR-006](./ADR-006-agent-memory-architecture.md))
3. **LangGraph checkpoint store** — key-value persistence for agent state (see [ADR-005](./ADR-005-agent-state-persistence.md))
4. **Audit log storage** — structured, queryable event rows (see [ADR-008](./ADR-008-audit-logging.md))
5. **Multi-writer access** — tcp-server and tcp-agent both write concurrently (see [ADR-001](./ADR-001-service-architecture.md))

## Options

| Option                    | Relational | Vector search                                 | Multi-writer            | Notes                                                                                        |
| ------------------------- | ---------- | --------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| **SQLite (file-based)**   | ✓          | ✗ (sqlite-vec extension possible but limited) | ✗ (write lock per file) | Simple; single-file backup; not suitable for concurrent writers or embeddings                |
| **PostgreSQL + pgvector** | ✓          | ✓                                             | ✓                       | Production-grade; covers all four requirements in one service; well-supported TypeORM driver |

## Decision

**PostgreSQL with the `pgvector` extension**.

One service covers all four requirements. The `@langchain/langgraph-checkpoint-postgres` adapter uses PostgreSQL natively. TypeORM's `postgres` driver is already a supported option.

### Migration path from current SQLite setup

1. Add `pg` and `typeorm` postgres driver to dependencies (replace `better-sqlite3` in production config)
2. Update `app.module.ts` TypeORM config to read connection string from `DATABASE_URL` environment variable
3. Keep `better-sqlite3` in `devDependencies` — unit tests (`*.spec.ts`) continue to use an in-memory SQLite database for speed (no Docker required for `npm test`)
4. e2e tests (`npm run test:e2e`) use a PostgreSQL instance (provided by Docker Compose in CI and local dev)
5. Run `CREATE EXTENSION IF NOT EXISTS vector;` on first boot (or in a migration)

### Environment config

| Variable        | Usage                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------ |
| `DATABASE_URL`  | PostgreSQL connection string (`postgres://user:pass@host:5432/tcp`)                        |
| `DATABASE_TYPE` | `postgres` (production) or `better-sqlite3` (test) — defaults to `better-sqlite3` if unset |

## Consequences

- PostgreSQL is added to Docker Compose (see [ADR-009](./ADR-009-containerization-strategy.md))
- TypeORM entities remain in `src/models/` following existing conventions
- The `schemas/schema.json` generation pipeline is unaffected (driven by TypeScript types, not the DB driver)
- New entities (tasks, roles, memories, audit events) follow the existing TSDoc annotation pattern in `src/models/`

## Open Questions / Assumptions

- pgvector version compatibility with PostgreSQL — use the official `pgvector/pgvector` Docker image which bundles both
- TypeORM does not natively model `vector` columns; a raw column type (`vector(1536)`) with manual query for similarity search, or the `typeorm-extension` / raw SQL approach, will be used for vector queries

<a id="amendment-as-implemented-0092"></a>

## Amendment as implemented (009.2)

**Timestamp storage convention**: `Date`-typed entity columns (e.g. `TcpAgent.createdAt`) are deliberately left **untyped** (no explicit `type: 'timestamptz'`/`'datetime'`) so the same entities work against both `better-sqlite3` (tests) and PostgreSQL (production) — an explicit type string breaks one driver or the other. A hand-written, PostgreSQL-only migration (`TimestamptzConsistency`) converts the underlying columns to `TIMESTAMPTZ` directly in schema DDL (assuming a UTC Postgres session timezone), without touching entity metadata. `npm run migration:generate` will report this as permanent "drift" against the untyped entities — expected, and already covered by the project's existing drift-is-diagnostic-only convention (see `docs/database.md#timestamp-storage-convention`), not something to "fix" by adding explicit types back.

<a id="amendment-as-implemented-0107"></a>

## Amendment as implemented (010.7)

**Vector dimension**: the "Open Questions" section above assumed `vector(1536)`, matching OpenAI's `text-embedding-ada-002`/`text-embedding-3-small`. In practice this was an unrepresentative default — most local/open embedding models run via LM Studio or similar (`nomic-embed-text`, `bge-base`, `gte-base`, ...) are natively 768-dimensional, and pgvector's `vector(N)` column width is fixed and shared across every company (no per-company flexibility without a much larger redesign). Migration `ChangeEmbeddingDimension1784600000000` changed `knowledge_chunk.embedding`/`episodic_memory.embedding` to `vector(768)`. A future embedding model at a different native dimension requires the same treatment: a new migration dropping and re-creating the column (and its `ivfflat` index) at the new width, plus re-indexing every affected scope — there is no way to convert a vector between dimensions in place.
