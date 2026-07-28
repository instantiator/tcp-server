# Development

The tech stack, source layout, everyday commands, and project conventions. Read this when starting work on the codebase.

## Project overview

NestJS monorepo for the TCP system: `tcp-server` (REST API + orchestration state), `tcp-agent` (agent loop runner), `tcp-cli` (CLI client), and four MCP servers agents call for tools — `tcp-mcp-storage`, `tcp-mcp-memory`, `tcp-mcp-interactions`, `tcp-mcp-tasks`. Shared entities, prompt assembly, and cross-app utilities live in `libs/tcp-shared` (imported as `@tcp/shared`). Data is persisted in PostgreSQL + pgvector in production; better-sqlite3 in-memory for unit tests.

## Tech stack (currently implemented)

| Concern               | Choice                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| Runtime               | Node.js / TypeScript (strict mode)                                                                   |
| Framework             | NestJS 11 (monorepo mode, 6 apps + `tcp-cli`)                                                        |
| ORM                   | TypeORM                                                                                              |
| Database (production) | PostgreSQL 16 + pgvector                                                                             |
| Database (unit tests) | better-sqlite3 (in-memory)                                                                           |
| Auth                  | OAuth2/OIDC — Zitadel (default), any OIDC IdP supported                                              |
| Object storage        | MinIO (Docker Compose)                                                                               |
| Task queue            | Redis + BullMQ — `agent-jobs` (tcp-server → tcp-agent) and `knowledge-reindex` (tcp-server-internal) |
| API docs              | `@nestjs/swagger` — `GET /swagger` + `GET /swagger-json` on all six server apps                      |
| Testing               | Jest + `@nestjs/testing`; testcontainers for integration/e2e                                         |
| Linting               | ESLint + typescript-eslint                                                                           |
| Formatting            | Prettier                                                                                             |
| Schema export         | ts-json-schema-generator → `schemas/schema.json`                                                     |

Architectural decisions are documented as ADRs in `ADRs/`. See [index.md](index.md) for the full list with implementation status.

## Source layout

```
apps/
  tcp-server/            # REST API + orchestration state (port 3000)
    src/
      api/                # HTTP layer — controllers + services (company, role, agent, task,
                           # assignment/task-orchestration, conversation, storage proxy,
                           # system shutdown/drain, ...)
      audit/               # AuditService — internal audit-event endpoint
      auth/                # OIDC JWT strategy + guard
      config/              # Joi validation schema for env vars
      context/             # Context-budget/compaction wiring specific to tcp-server
      db/                  # DbService — TypeORM repository wrapper
      events/              # AuditEventPublisher + three KeyedEventBus<WireEvent> (agent/task/company SSE)
      health/              # GET /health endpoint (@nestjs/terminus)
      mcp/                 # Internal MCP-facing endpoints (storage-scope, etc.)
      migrations/          # TypeORM migrations (run on startup vs postgres)
      model-check/         # LLM/embedding model compatibility check
      rag/                 # RAG retrieval + KnowledgeReindexService (write hook + poller)
      storage/             # StorageService abstraction, MinioStorageAdapter, storage-keys
      templates/           # Input shapes for create operations
      utils/               # Shared utilities (ObjectUtils)
      data-source.ts       # TypeORM CLI datasource (migration:generate etc.)
    Dockerfile
  tcp-agent/              # Agent loop runner (port 3001)
    src/
      agent/               # AgentLoopService — LangGraph agent loop, initial-state assembly
      config/              # Joi validation schema for env vars
      health/              # GET /health endpoint
      mcp/                 # McpClientService wiring for the agent loop
      rag/                 # AgentRagService — the worker's "is anything indexed?" check
                           # (retrieval itself is @tcp/shared's KnowledgeRetrievalService)
      registry/            # Role/company/agent lookups the worker needs
      storage-tracking/    # Tracks storage-scope resolution for a running agent
      worker/               # AgentWorkerService — BullMQ `agent-jobs` consumer
    Dockerfile
  tcp-mcp-storage/        # Storage MCP server (port 3010)
  tcp-mcp-memory/         # Memory MCP server — recall/remember/search_knowledge (port 3011)
  tcp-mcp-interactions/   # Interactions MCP server — user input, agent consultation (port 3012)
  tcp-mcp-tasks/          # Tasks MCP server — create_plan/complete_assignment/assure_assignment (port 3013)
                           # Each MCP app follows the same shape: src/mcp/, a tools.jsonc +
                           # prompts.jsonc pair, and a thin HTTP-proxy *-tools.service.ts
                           # calling tcp-server's /internal/* endpoints via InternalApiClient.
                           # Bootstrap, health and config come from @tcp/shared
                           # (bootstrapMcpApp, StaticHealthModule, mcpConfigModule); only
                           # tcp-mcp-memory keeps its own health module, for its DB ping.
  tcp-stub-llm/           # Configurable stub LLM server for tests (port 3002) — see docs/stub-llm.md.
                           # Standalone: own package.json/tsconfig/lint config, no NestJS, no @tcp/shared.
  tcp-cli/
    src/
      main.ts               # commander entry point; global options
      commands/             # thin per-command registration (flags → lib/<domain> action)
      lib/
        core/                # api.ts, cli-options.ts, run-command.ts, sse.ts (parseWireEvents), render.ts, ...
        render/              # shared render library: EventLogBuffer, StreamPresenter, renderers, style backends
        auth/                # token.ts (resolution/renewal) + get-token action
        chat/                # chat command: flags, context, session, wiring, action
        tui/                 # full-screen TUI (terminal-kit widgets)
        system/              # fleet-level actions: shutdown drain (see docs/tcp-cli.md#shutdown)
        crud/, docs/, queries/, links/  # remaining commands' actions, grouped by purpose
    tsconfig.app.json        # extends root; adds @tcp/shared paths
    tsconfig.json            # extends tsconfig.app.json; includes spec files (for ESLint)
libs/
  tcp-shared/
    src/
      models/                # TypeORM entities (shared across all apps) — doubles as JSON Schema source
      audit/                 # AuditClientService (used by all apps)
      bootstrap/             # bootstrapMcpApp — shared MCP server startup
      health/                # StaticHealthModule — /health for services with no dependency to probe
      http/                  # InternalApiClient — authenticated calls to tcp-server /internal/*
      auth/                  # InternalApiKeyGuard
      config/                # defaults, run-config/llm-config/system-prompt-template resolution
      context/                # Context budget, compaction, and incoming-data-guard services
      db/                     # makeTypeOrmConfig factory + optimistic-retry helper
      events/                 # WireEvent (unified SSE/Redis shape) + channel/summary helpers
      llm/                    # buildChatModel factory, agent-graph builder, reasoning-content recovery
      mcp/                    # BaseMcpController, McpClientService, MCP_REGISTRY, resolve-mcp-server-list,
                              # tool-result kit (ToolResult, ok/err, relay4xxOrError)
      prompts/                # mode-prompts, mode-tools, prompt-assembly, qa-prompts — the single
                               # home for every prompt-part builder shared by tcp-server and tcp-agent
      rag/                    # EmbeddingService, KnowledgeRetrievalService
      redis/                  # assertRedisReachable
      storage/                # artifact-keys (resolveArtifactKey), write validation, stream-to-buffer
      validation/              # enum validation, control-char sanitisation
      index.ts                 # Re-exports all shared code
    tsconfig.lib.json
test/
  api/                       # API contract tests — authenticated HTTP round-trips (need docker compose up --profile auth)
  e2e/
    tcp-server/              # tcp-server E2E specs (company-role, agent, task-orchestration, users, audit, etc.)
    tcp-agent/                # tcp-agent health E2E spec
    tcp-mcp-interactions/     # tcp-mcp-interactions health + MCP protocol E2E specs
    tcp-mcp-memory/           # tcp-mcp-memory health + MCP protocol E2E specs (skipped without Postgres)
    tcp-mcp-storage/          # tcp-mcp-storage health + MCP protocol E2E specs
    helpers/                  # Shared E2E utilities (test-jwt helper)
  integration/
    tcp-server/               # tcp-server service connectivity tests (need Docker)
    tcp-agent/                 # tcp-agent service connectivity tests (need Docker)
    tcp-shared/                 # makeTypeOrmConfig integration test (need Docker for Postgres path)
  smoke/                       # Full-stack health checks, all six server apps (need docker compose up --profile auth)
  jest-api.json               # Jest config for API tests
  jest-e2e.json                # Jest config for E2E tests
  jest-integration.json        # Jest config for integration tests
  jest-smoke.json              # Jest config for smoke tests
scripts/                       # Test runner scripts (mirror CI steps) + git hooks (npm run hooks:install)
docs/
  ADRs/                        # Architectural Decision Records
  zitadel-setup.md             # Zitadel setup guide
  licenses.md                  # Auto-generated — do not edit by hand
dev-environment/                # Git submodule — agent guidance, skills, and quality-gate scripts
schemas/                        # Auto-generated JSON Schema — do not edit by hand
```

`tcp-mcp-tasks` is the odd one out among the MCP apps: alongside the HTTP-proxy pattern it also holds `AuditClientService` (from `@tcp/shared`) to record its own tool-call audit events, since its completion tools (`create_plan`/`complete_assignment`/`assure_assignment`) are higher-stakes than the other services' reads and writes.

## Common commands

```bash
# Development
npm run start:dev             # Start tcp-server with hot reload (SQLite fallback)
./tcp-cli.sh                  # Run tcp-cli (builds automatically if needed)
./tcp-cli.sh --rebuild        # Force rebuild before running
npm run build                 # Build all apps + generate schema + license report
npm run build tcp-server      # Build tcp-server only
npm run build tcp-agent       # Build tcp-agent only
npm run build:tcp-cli         # Build tcp-cli standalone binary
npm run lint                  # ESLint with auto-fix
npm run format                # Prettier over apps/, libs/, test/, docs/

# Quality gate (also run by the git hooks)
./dev-environment/scripts/check.sh          # Full: lint, typecheck, build, unit tests, aislop
./dev-environment/scripts/check.sh --fast   # Fast: lint, typecheck, shellcheck only

# Testing
npm test                      # Unit tests (no external services, SQLite in-memory)
npm run test:e2e              # E2E tests (testcontainers starts postgres/redis/minio)
npm run test:integration      # Integration tests (testcontainers starts postgres/redis/minio/stub-llm)
npm run test:api              # API contract tests (requires docker compose up --profile auth)
npm run test:smoke            # Smoke tests (requires a running deployment)
npm run test:cov              # Coverage report

# Test scripts (mirrors CI, starts Docker services as needed)
./scripts/run-unit-tests.sh
./scripts/run-e2e-tests.sh
./scripts/run-integration-tests.sh
./scripts/run-api-tests.sh
./scripts/run-smoke-tests.sh
./scripts/run-all-tests.sh    # All five tiers

# Docker
docker compose up             # Start all services
docker compose --profile auth up  # Also start Zitadel
docker compose down           # Stop services (keep volumes)
docker compose down -v        # Stop and remove volumes

# Migrations
npm run migration:generate -- apps/tcp-server/src/migrations/Name  # Generate from entity diff
npm run migration:run         # Run pending migrations
npm run migration:revert      # Revert last migration
```

## Key environment variables

Beyond the database/Redis/MinIO/OIDC connection strings (see `.env.example`), a few app-specific ones are easy to miss:

| Variable                     | App(s)                | Purpose                                                                           |
| ---------------------------- | --------------------- | --------------------------------------------------------------------------------- |
| `MCP_STORAGE_URL`            | tcp-server, tcp-agent | `tcp-mcp-storage` base URL; omit to disable that server                           |
| `MCP_MEMORY_URL`             | tcp-server, tcp-agent | `tcp-mcp-memory` base URL; omit to disable that server                            |
| `MCP_INTERACTIONS_URL`       | tcp-server, tcp-agent | `tcp-mcp-interactions` base URL; omit to disable that server                      |
| `MCP_TASKS_URL`              | tcp-server, tcp-agent | `tcp-mcp-tasks` base URL; omit to disable that server                             |
| `INTERNAL_API_KEY`           | all apps              | Shared secret for internal service-to-service calls (`X-Internal-Api-Key`)        |
| `KNOWLEDGE_POLL_INTERVAL_MS` | tcp-server            | Reconciliation-poll interval for the `knowledge-reindex` sync (default `60000`)   |
| `TASK_MAX_QA_ATTEMPTS`       | tcp-server            | Env-level fallback for `runConfig.maxQaAttempts` (role/company override it first) |
| `RAG_THRESHOLD`              | tcp-server, tcp-agent | Env-level fallback for `runConfig.ragThreshold` (role/company override it first)  |
| `TCP_MASK_API_KEYS`          | tcp-server            | Masks `LlmConfig.apiKey` in API responses (default `true`)                        |

### Tuning RAG retrieval

Knowledge chunks are returned only when their cosine similarity to the query
meets `runConfig.ragThreshold` (role → company → `RAG_THRESHOLD` →
`DEFAULT_RAG_THRESHOLD`, currently `0.35`).

Every path retrieves through the same `KnowledgeRetrievalService` in
`@tcp/shared` — tcp-server's chat and knowledge queries, tcp-agent's prompt
assembly, and tcp-mcp-memory's `search_knowledge` tool — so one threshold
governs them all. `recall` is the exception: it runs its own hybrid query
across episodic memory as well as knowledge, and keeps its own cut-off.

**Cosine scores are not comparable across embedding models** — each has its own
score distribution, so this is a per-model calibration rather than a universal
"relevance" figure. Set it too high and retrieval silently returns nothing at
all, with no error to explain the empty prompt.

To calibrate after changing embedding model, query with `--threshold 0` to see
raw scores, using queries you know should and shouldn't match:

```bash
./tcp-cli.sh query-knowledge -c <company> -r <role> -q "a question the docs answer" --threshold 0
./tcp-cli.sh query-knowledge -c <company> -r <role> -q "something wholly unrelated" --threshold 0
```

Pick a value in the gap between the two. With no `--threshold`, the command
reports exactly what that role would retrieve in a real prompt.

## Key conventions

- **`libs/tcp-shared`** is the shared library imported as `@tcp/shared` from any app. See the source-layout tree above for what lives where; `models/`, `prompts/`, and `mcp/` are the ones every app touches.
- **Entities in `libs/tcp-shared/src/models/`** double as TypeORM entities and JSON Schema sources. Annotate with TSDoc validation tags (`@format`, `@minLength`, etc.) so the generated schema is accurate.
- **Prompt content lives in `libs/tcp-shared/src/prompts/`** — `mode-prompts.ts` (per-mode preambles), `mode-tools.ts` (per-mode server/tool gating), `prompt-assembly.ts` (the shared initial-prompt-part builders used by both `ChatService` and `AgentLoopService`), and `qa-prompts.ts` (QA presentation/rejection text used by `TaskOrchestrationService`). Add new prompt-part logic here, not locally in an app, so tcp-server and tcp-agent can't drift.
- **`schemas/schema.json`** and **`docs/licenses.md`** are generated artefacts — never edit them directly; regenerate via `npm run build`.
- **Unit tests** (`.spec.ts`) use `better-sqlite3` in-memory; wire TypeORM directly in `Test.createTestingModule`, never through `AppModule`.
- **Integration and e2e tests** boot against real PostgreSQL, Redis, and MinIO started by [testcontainers](https://node.testcontainers.org/) from Jest's global setup (`test/{integration,e2e}/global-setup.ts`), on random host ports. Connection env vars are provisioned there, so `require-env.ts` (not a silent skip) guards each spec. See [docs/testing.md](testing.md#test-infrastructure).
- **Event architecture (audit-as-source-of-truth)**: audit events are the single source of truth for both history and live streaming (see [ADR-008](ADRs/ADR-008-audit-logging.md)). `AuditService.write` persists a row then hands it to `AuditEventPublisher`, which emits it as a `WireEvent` (`{ type: 'audit'; event }` or a live-only `{ type: 'stream'; … }` token delta — the sole non-audit wire shape) on the relevant agent/task/company SSE channel. All three CLI surfaces (`tui`, `chat`, `eavesdrop`) render through one shared library — `apps/tcp-cli/src/lib/render/` (`EventLogBuffer` accumulates events; `StreamPresenter` writes stdout/stderr incrementally; the renderer registry maps each audit event to display lines) — so history replay and the live stream produce identical output. Add new event kinds by extending the renderer registry, not by adding a parallel event family.
- **Redis fail-fast**: services that depend on Redis (agent orchestration, the agent worker, the knowledge-reindex queue) probe reachability at startup via `assertRedisReachable` (`@tcp/shared`) and refuse to start with a clear error if it's unreachable, rather than letting BullMQ block forever. tcp-server and tcp-agent both call `app.enableShutdownHooks()` so their queue/worker/Redis connections close cleanly on `SIGTERM`.
- **Testing intentional error paths**: when a test deliberately triggers a service-level `Logger.warn`/`.error` call (e.g. `POST /internal/agent/:id/fail`), use `captureNestLogs()`/`expectLoggedError()` from `test/e2e/helpers/log-capture.ts` to silence and assert on it, instead of letting it print during a normal test run. HTTP-level errors (404/400/401/409 via `HttpException`) aren't logged by Nest's default filter, so most error-path tests don't need this — it's only for paths that call a `Logger` directly.
- **Migrations**: use `synchronize: false` in production. Always create a migration when changing entity schema. Never use `synchronize: true` with PostgreSQL. New migration files must also be registered by hand in each app's `app.module.ts` migrations array.
- **No secrets in code.** Use environment variables for all credentials. Required vars are validated by Joi on startup — the app will not start if any are missing.
- **Zitadel** is optional for local dev. Run without it by setting stub OIDC env vars (see `.env.example`). `JwtAuthGuard` is applied to every user-facing controller across the API.
- **Soft data-quality warnings** (e.g. a role with no `knowledgeDomains`, a blank `companyContext`/`rolePrompt`) never fail the request — they're reported via the `X-Tcp-Warnings` response header (JSON array of strings) on `POST`/`PUT` company and role routes. See `apps/tcp-server/src/api/validation-warnings.ts`; `tcp-cli` prints these to stderr (see `docs/tcp-cli.md`).
