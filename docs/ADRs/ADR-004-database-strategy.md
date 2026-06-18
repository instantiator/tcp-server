# ADR-004: Database Strategy

Status: Proposed

## Context

`lcp-server` currently uses `better-sqlite3` in-memory via TypeORM, which is adequate for development and unit testing but unsuitable for production. The full system needs a database that supports:

1. **Relational data** — companies, users, roles, tasks, task steps, agent runs
2. **Vector embeddings** — role memories and RAG knowledge base retrieval (see [ADR-006](./ADR-006-agent-memory-architecture.md))
3. **LangGraph checkpoint store** — key-value persistence for agent state (see [ADR-005](./ADR-005-agent-state-persistence.md))
4. **Audit log storage** — structured, queryable event rows (see [ADR-008](./ADR-008-audit-logging.md))
5. **Multi-writer access** — lcp-server and lcp-agent both write concurrently (see [ADR-001](./ADR-001-service-architecture.md))

## Options

| Option | Relational | Vector search | Multi-writer | Notes |
|--------|-----------|---------------|--------------|-------|
| **SQLite (file-based)** | ✓ | ✗ (sqlite-vec extension possible but limited) | ✗ (write lock per file) | Simple; single-file backup; not suitable for concurrent writers or embeddings |
| **PostgreSQL + pgvector** | ✓ | ✓ | ✓ | Production-grade; covers all four requirements in one service; well-supported TypeORM driver |

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

| Variable | Usage |
|----------|-------|
| `DATABASE_URL` | PostgreSQL connection string (`postgres://user:pass@host:5432/lcp`) |
| `DATABASE_TYPE` | `postgres` (production) or `better-sqlite3` (test) — defaults to `better-sqlite3` if unset |

## Consequences

- PostgreSQL is added to Docker Compose (see [ADR-009](./ADR-009-containerization-strategy.md))
- TypeORM entities remain in `src/models/` following existing conventions
- The `schemas/schema.json` generation pipeline is unaffected (driven by TypeScript types, not the DB driver)
- New entities (tasks, roles, memories, audit events) follow the existing TSDoc annotation pattern in `src/models/`

## Open Questions / Assumptions

- pgvector version compatibility with PostgreSQL — use the official `pgvector/pgvector` Docker image which bundles both
- TypeORM does not natively model `vector` columns; a raw column type (`vector(1536)`) with manual query for similarity search, or the `typeorm-extension` / raw SQL approach, will be used for vector queries
