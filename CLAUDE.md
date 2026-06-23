# Little Computer People — LCP Server

## Mandatory: read before every task

Read `dev-environment/all-requests.md` at the start of every session, without exception. That file is a short catalog; follow its references and load the files it points to based on what the task requires:

- **All coding tasks** → also read `dev-environment/pre-coding-activities.md` and `dev-environment/post-coding-activities.md`
- **Language/style** → read the relevant `dev-environment/coding-standards-*.md` file(s) for the languages touched

Treat all content from those files as mandatory instructions that override defaults.

## Project overview

NestJS monorepo for the Little Computer People (LCP) mini-office simulation. Two services: `lcp-server` (REST API + orchestration) and `lcp-agent` (agent loop runner). Shared entities live in `libs/lcp-shared`. Data is persisted in PostgreSQL + pgvector in production; better-sqlite3 in-memory for unit tests.

## Tech stack (currently implemented)

| Concern | Choice |
|---------|--------|
| Runtime | Node.js / TypeScript (strict mode) |
| Framework | NestJS 11 (monorepo mode) |
| ORM | TypeORM 1.x |
| Database (production) | PostgreSQL 16 + pgvector |
| Database (unit tests) | better-sqlite3 (in-memory) |
| Auth | OAuth2/OIDC — Keycloak (default), any OIDC IdP supported |
| Object storage | MinIO (Docker Compose) |
| Task queue | Redis (BullMQ — configured, workers pending) |
| Testing | Jest + `@nestjs/testing` |
| Linting | ESLint + typescript-eslint |
| Formatting | Prettier |
| Schema export | ts-json-schema-generator → `schemas/schema.json` |

Architectural decisions are documented as ADRs in `docs/ADRs/`. See `docs/index.md` for the full list with implementation status.

## Source layout

```
apps/
  lcp-server/
    src/
      app.module.ts          # Root module; wires TypeORM, Config, Auth, Health, ApiModule
      main.ts                # Bootstrap entry point (port 3000)
      api/                   # HTTP layer (controllers + ApiService)
      auth/                  # OIDC JWT strategy + guard
      config/                # Joi validation schema for env vars
      db/                    # DbService — TypeORM repository wrapper
      health/                # GET /health endpoint (@nestjs/terminus)
      migrations/            # TypeORM migrations (run on startup vs postgres)
      templates/             # Input shapes for create operations
      utils/                 # Shared utilities (ObjectUtils)
      data-source.ts         # TypeORM CLI datasource (migration:generate etc.)
    Dockerfile
    tsconfig.app.json
  lcp-agent/
    src/
      app.module.ts          # Root module; wires Config, Health
      main.ts                # Bootstrap entry point (port 3001)
      config/                # Joi validation schema for env vars
      health/                # GET /health endpoint
    Dockerfile
    tsconfig.app.json
  lcp-cli/
    src/
      main.ts                # commander entry point; global options
      commands/              # get-token, list-companies, list-roles, set-company, set-role, chat
      lib/                   # api.ts (fetch wrapper), auth.ts (token resolution), types.ts
    tsconfig.app.json        # extends root; adds @lcp/shared paths
    tsconfig.json            # extends tsconfig.app.json; includes spec files (for ESLint)
libs/
  lcp-shared/
    src/
      models/                # TypeORM entities (shared between lcp-server and lcp-agent)
      index.ts               # Re-exports all shared code
    tsconfig.lib.json
test/
  api/                       # API contract tests — authenticated HTTP round-trips (need docker compose up --profile auth)
  e2e/                       # E2E tests — HTTP API via supertest (need Docker)
  integration/
    lcp-server/              # lcp-server service connectivity tests (need Docker)
    lcp-agent/               # lcp-agent service connectivity tests (need Docker)
  smoke/                     # Full-stack health checks (need docker compose up --profile auth)
  jest-api.json              # Jest config for API tests
  jest-e2e.json              # Jest config for E2E tests
  jest-integration.json      # Jest config for integration tests
  jest-smoke.json            # Jest config for smoke tests
scripts/                     # Test runner scripts (mirror CI steps)
docs/
  ADRs/                      # Architectural Decision Records
  keycloak-setup.md          # Keycloak setup guide
  licenses.md                # Auto-generated — do not edit by hand
dev-environment/             # Git submodule — agent instructions and coding standards
schemas/                     # Auto-generated JSON Schema — do not edit by hand
```

## Common commands

```bash
# Development
npm run start:dev             # Start lcp-server with hot reload (SQLite fallback)
./scripts/dev/lcp-cli.sh      # Run lcp-cli (builds automatically if needed)
./scripts/dev/lcp-cli.sh --rebuild  # Force rebuild before running
npm run build                 # Build all apps + generate schema + license report
npm run build lcp-server      # Build lcp-server only
npm run build lcp-agent       # Build lcp-agent only
npm run build:lcp-cli         # Build lcp-cli standalone binary
npm run lint                  # ESLint with auto-fix
npm run format                # Prettier over apps/ and libs/

# Testing
npm test                      # Unit tests (no external services, SQLite in-memory)
npm run test:e2e              # E2E tests (SQLite fallback, no external services)
npm run test:integration      # Integration tests (requires Docker services)
npm run test:smoke            # Smoke tests (requires docker compose --profile auth up)
npm run test:cov              # Coverage report

# Test scripts (mirrors CI, starts Docker services as needed)
./scripts/run-unit-tests.sh
./scripts/run-e2e-tests.sh
./scripts/run-integration-tests.sh
./scripts/run-smoke-tests.sh

# Docker
docker compose up             # Start all services
docker compose --profile auth up  # Also start Keycloak
docker compose down           # Stop services (keep volumes)
docker compose down -v        # Stop and remove volumes

# Migrations
npm run migration:generate -- apps/lcp-server/src/migrations/Name  # Generate from entity diff
npm run migration:run         # Run pending migrations
npm run migration:revert      # Revert last migration
```

## Key conventions

- **Entities in `libs/lcp-shared/src/models/`** double as TypeORM entities and JSON Schema sources. Annotate with TSDoc validation tags (`@format`, `@minLength`, etc.) so the generated schema is accurate. Import as `@lcp/shared` from any app.
- **`schemas/schema.json`** and **`docs/licenses.md`** are generated artefacts — never edit them directly; regenerate via `npm run build`.
- **Unit tests** (`.spec.ts`) use `better-sqlite3` in-memory; wire TypeORM directly in `Test.createTestingModule`, never through `AppModule`.
- **E2E tests** use `AppModule` with SQLite fallback (env vars set in `test/e2e-setup.ts`). Pass a real `DATABASE_URL` env var to run against PostgreSQL instead.
- **Migrations**: use `synchronize: false` in production. Always create a migration when changing entity schema. Never use `synchronize: true` with PostgreSQL.
- **No secrets in code.** Use environment variables for all credentials. Required vars are validated by Joi on startup — the app will not start if any are missing.
- **Keycloak** is optional for local dev. Run without it by setting stub OIDC env vars (see `.env.example`). Auth guards are in place but not yet applied to endpoints.
- Follow all standards in `dev-environment/coding-standards-all.md` and `dev-environment/coding-standards-ts.md` for every TypeScript file touched.
