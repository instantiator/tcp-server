# ADR-018: System Configuration and Setup Wizard

Status: Accepted

## Context

TCP Server currently requires manual configuration of environment variables, with limited guidance for new deployments. Key pain points:

1. **No structured first-time setup** — users must manually edit `.env` files, consult documentation, and understand the relationship between services (PostgreSQL, Redis, MinIO, OIDC, LLM providers).

2. **Fixed embedding dimensions** — the vector database columns are hardcoded to `vector(768)`. Changing the embedding model later requires manual migration and re-indexing of all scopes, with no tooling to assist.

3. **Single `.env` file assumption** — while the apps technically support any env file (loaded by deployment scripts), there's no established pattern for multi-environment configs (dev, testing, production) with sensible defaults.

4. **No validation before startup** — misconfigured LLM endpoints or embedding models cause runtime failures rather than being caught at setup time.

The goal is to provide:

- A setup wizard that guides users through initial configuration
- Configurable embedding dimensions with automatic migration
- Environment files with clear variable naming conventions
- A standalone script for changing the embedding model post-setup

## Options considered

1. **Manual configuration only** (status quo)
   - Pros: Simple, no new tooling
   - Cons: Error-prone, poor onboarding experience, embedding model changes require expertise

2. **Setup wizard + auto-migrate**
   - Pros: Guided experience, catches errors early, simplifies embedding model changes
   - Cons: More code to maintain, migration auto-run needs safety guards

3. **Setup wizard + manual migration**
   - Pros: Safer (user controls migration timing)
   - Cons: More steps for user, still requires expertise for migration

## Decision

**Option 2: Setup wizard + auto-migrate with confirmation**

### 1. Configuration defaults in code

All fallback default values live in `libs/tcp-shared/src/config/defaults.ts` — the single source of truth. This eliminates the need for `.env.defaults` files and ensures defaults are typed, testable, and consistent across all apps.

Joi schemas in each app import defaults from `defaults.ts` via `@tcp/shared/config/defaults`.

### 2. Environment variable conventions

**User-configurable variables** (in `.env.*` files):

| Variable                                | Default                 | Notes                                              |
| --------------------------------------- | ----------------------- | -------------------------------------------------- |
| `EXPOSE_PORT_API`                       | 3000                    | Base port; others derived via offsets              |
| `EXPOSE_PORT_DB`                        | 5432                    | Formula: API + 2432                                |
| `EXPOSE_PORT_MINIO`                     | 9000                    | Formula: API + 6000                                |
| `EXPOSE_PORT_ZITADEL`                   | 8080                    | Formula: API + 5080                                |
| `DB_USER`                               | tcp                     |                                                    |
| `DB_PASSWORD`                           | dev-password            | Renamed from `POSTGRES_PASSWORD`                   |
| `DB_NAME`                               | tcp                     | New variable                                       |
| `MINIO_ACCESS_KEY`                      | tcp-access-key          |                                                    |
| `MINIO_SECRET_KEY`                      | tcp-secret-key          |                                                    |
| `MINIO_BUCKET_PREFIX`                   | tcp                     |                                                    |
| `INTERNAL_API_KEY`                      | change-me-in-production |                                                    |
| `OIDC_ISSUER_URL`                       | —                       | Absent = derives from `EXPOSE_PORT_ZITADEL`        |
| `OIDC_CLIENT_ID`                        | —                       | Generated/provider-issued → `<env>.local` (see §7) |
| `OIDC_CLIENT_SECRET`                    | —                       | Generated/provider-issued → `<env>.local` (see §7) |
| `TEST_CLIENT_ID` / `TEST_CLIENT_SECRET` | —                       | Machine test user → `<env>.local` (see §7)         |
| `EMBEDDING_DIMENSION`                   | 768                     |                                                    |

**Docker-internal variables** (defined in `docker-compose.yml` via YAML anchors):

| Variable                   | Value                                                                     | Mapped to app variable     |
| -------------------------- | ------------------------------------------------------------------------- | -------------------------- |
| `INTERNAL_URL_DB`          | `postgres://${DB_USER:-tcp}:${DB_PASSWORD}@postgres:5432/${DB_NAME:-tcp}` | `DATABASE_URL`             |
| `INTERNAL_URL_REDIS`       | `redis://redis:6379`                                                      | `REDIS_URL`                |
| `INTERNAL_URL_MINIO`       | `http://minio:9000`                                                       | `MINIO_ENDPOINT`           |
| `INTERNAL_URL_OIDC_ISSUER` | `http://zitadel:8080`                                                     | `OIDC_INTERNAL_ISSUER_URL` |
| `INTERNAL_URL_TCP_SERVER`  | `http://tcp-server:3000`                                                  | `TCP_SERVER_URL`           |

**Host-facing URLs** (derived at runtime, not stored in `.env.*`):

| Variable          | Derivation                                                                    |
| ----------------- | ----------------------------------------------------------------------------- |
| `DATABASE_URL`    | `postgres://${DB_USER}:${DB_PASSWORD}@localhost:${EXPOSE_PORT_DB}/${DB_NAME}` |
| `MINIO_ENDPOINT`  | `http://localhost:${EXPOSE_PORT_MINIO}`                                       |
| `OIDC_ISSUER_URL` | Explicit value, or `http://localhost:${EXPOSE_PORT_ZITADEL}` if not set       |

URL derivation happens in `scripts/lib/derive-urls.sh`, called by deployment and test scripts.

### 3. Configurable embedding dimension

A new env var `EMBEDDING_DIMENSION` (default: 768) controls the vector column width. On startup, tcp-server compares this value against the actual database schema:

- **If unchanged**: no action
- **If changed**: prompt user for confirmation, then:
  1. Generate a migration to drop and recreate `knowledge_chunk.embedding` and `episodic_memory.embedding` columns at the new dimension
  2. Drop and recreate the IVFFlat indexes
  3. Trigger a full re-index of all knowledge scopes

This eliminates the need for manual migration expertise when switching embedding models.

### 4. Setup wizard

A standalone Node/TypeScript script using `inquirer`, invoked via:

- `npm run setup` (builds and runs)
- `./scripts/setup-wizard.sh` (pre-built wrapper)

**Wizard flow:**

1. **Instance configuration**
   - "Instance suffix (the part after 'tcp-'): (default: dev)"
   - "Env file name: (default: .env.dev)"

2. **Port configuration**
   - "API port (host-facing): (default: 3000)"
   - Show derived ports (DB, MinIO, Zitadel)
   - "Override any of the derived ports? (y/n)"

3. **LLM configuration (optional)**
   - "Configure an embedding model at application level? (y/n)"
   - If yes → sub-questions: provider, model, base URL, API key
   - Validate: probe endpoint, send test embedding, confirm dimension
   - Allow skip: "Skip connectivity validation? (y/n)"

   - "Configure an inference (chat) model at application level? (y/n)"
   - If yes → sub-questions: provider, model, base URL, API key, context window
   - Validate: send test chat completion
   - Allow skip option

4. **Authentication configuration (optional)**
   - "Use a third-party OIDC authentication provider? (y/n)"
   - If yes → sub-questions: issuer URL, client ID, client secret. The issuer URL
     is written to the committed file; the client credentials go to the gitignored
     `<env>.local` override (see §7).
   - If no → OIDC_ISSUER_URL is absent (derives from Zitadel port); the Zitadel
     bootstrap writes the generated client credentials to `<env>.local`.

5. **Resource limits**
   - "Maximum number of iterations an agent can perform? (default: 40)"
   - "Maximum number of concurrent agents? (default: 1)"

6. **Docker Compose configuration**
   - "Which services do you want to run? (default: all)"
   - Options: PostgreSQL, Redis, MinIO, Zitadel (OIDC), stub-llm

7. **Summary and write**
   - Display generated config
   - Write `.env.<instance>` (non-secret config) with explanatory comments, plus
     the gitignored `.env.<instance>.local` override (see §7)
   - Print next steps

### 5. Port-in-use checks

`scripts/lib/check-ports.sh` verifies `EXPOSE_PORT_*` ports are available before starting Docker Compose. Fails fast with a clear error if any port is already in use.

### 6. Set embedding model script

A standalone script for changing the embedding model post-setup:

- `npm run set-embedding-model` or `./scripts/set-embedding-model.sh`

**Flow:**

1. Prompt for new model config (provider, model, base URL, API key)
2. Validate connectivity
3. Probe embedding dimension
4. Compare against current `EMBEDDING_DIMENSION` in `.env`
5. If dimension changed:
   - Display warning: "Changing dimension requires re-indexing all knowledge. This may take time."
   - Prompt: "Run migration now? (y/n)"
   - If yes: generate and run migration, trigger re-index
   - If no: update `.env` only, print instructions for manual migration
6. Update `EMBEDDING_DIMENSION` and model config in `.env`

### 7. Config resolution: committed base + gitignored `.local` override

Some credentials must not be committed: the local Zitadel bootstrap **generates**
`OIDC_CLIENT_ID/SECRET` (for the `tcp-server` app) and `TEST_CLIENT_ID/SECRET`
(for the api-tier machine user) on **every** deployment run — Zitadel issues
client secrets server-side and can't be told a chosen value — and an external
OIDC provider issues its own fixed client id/secret per deployment. Committing
either produces per-run diffs and hands other users credentials their Zitadel
doesn't recognise.

Resolution follows the conventional dotenv-layering split:

- Each committed base env file (`.env.testing`, or a wizard-generated
  `.env.<instance>`) holds only static, shareable config.
- A gitignored **`<env-file>.local`** sibling holds the secrets that must not be
  committed — the `LOCAL_ONLY_ENV_KEYS`: `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`,
  `TEST_CLIENT_ID`, `TEST_CLIENT_SECRET` (single source of truth:
  `libs/tcp-shared/src/config/local-env-keys.ts`).
- Loaders apply the base file then the `.local` override (**local wins**); a
  value already in the environment (an explicit export) still wins over both.
  `start-deployment.sh` passes both to `docker compose` via repeated
  `--env-file`; the test harness uses `loadEnvFileWithLocal`.

`start-deployment.sh` **writes** the generated Zitadel credentials to `.local`
(never the committed file). The setup wizard writes an external provider's
client credentials to `.local` and leaves the bundled-Zitadel case to the
bootstrap. `.gitignore` ignores `.env*.local` (and `.env.run`).

Static test placeholders (`DB_PASSWORD`, `MINIO_*`, `ZITADEL_MASTERKEY`,
`ZITADEL_ADMIN_PASSWORD`, `INTERNAL_API_KEY`) are **not** rotating or
per-machine, so they stay in the committed `.env.testing` — the split targets
only generated/provider-issued credentials.

One nuance for `.env.testing`: the integration and e2e tiers boot tcp-server's
`AppModule` directly (no Zitadel bootstrap step), and its Joi schema _requires_
`OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET` even though those tiers never perform real
OIDC (auth is mocked / internal-key). So the committed `.env.testing` keeps
**inert placeholder** values for those two keys purely to satisfy validation;
the real generated values in `.env.testing.local` override them for the
api/smoke tier. `TEST_CLIENT_ID/SECRET` has no such requirement and stays
`.local`-only. The deployment/wizard flows don't need the placeholders because
the bootstrap writes real values to `.local` before any app boots.

**Considered but not adopted:** Zitadel JWT-profile machine keys (a persisted
key file rather than a rotating shared secret). The generate-then-capture flow
is idiomatic for Zitadel and, once captured into the gitignored `.local`, is
safe — so the extra moving part wasn't warranted.

See [010.8.4 - config resolution plan](../prompts/phase%2001%20-%20service/010.8.4%20-%20config%20resolution%20plan.md).

## Consequences

### Makes easier

- First-time deployment setup for new users
- Changing embedding models without deep PostgreSQL expertise
- Running multiple instances (dev, testing, prod) with different configs
- Validating LLM configuration before deploying

### Makes harder

- Migration safety (auto-detect adds complexity, requires confirmation flow)
- Testing the wizard itself (interactive prompts need mocking or snapshot testing)
- Documentation (must explain variable naming conventions and URL derivation)

### Risks

- Wizard may not cover edge cases in initial version (mitigate: allow manual `.env` editing as fallback)
- Auto-migration could fail on large datasets (mitigate: confirmation prompt, manual fallback instructions)

## Implementation Notes

### Files created

- `scripts/setup-wizard/` — wizard source directory
- `scripts/setup-wizard/index.ts` — main entry point
- `scripts/setup-wizard/prompts/` — question modules (instance, ports, llm, oidc, resources, docker)
- `scripts/setup-wizard/utils/` — helpers (env-writer, model-validator, dimension-prober, prompt-with-help, app-defaults)
- `scripts/setup-wizard/types.ts` — wizard config types
- `scripts/setup-wizard.sh` — shell wrapper
- `scripts/lib/derive-urls.sh` — host-facing URL derivation
- `scripts/lib/check-ports.sh` — port availability check
- `apps/tcp-server/src/migrations/1784800000000-DynamicEmbeddingDimension.ts` — parameterized dimension migration
- `apps/tcp-server/src/embedding-dimension-check.ts` — OnModuleInit startup check
- `libs/tcp-shared/src/config/local-env-keys.ts` — `LOCAL_ONLY_ENV_KEYS` (secrets that live in `<env>.local`)
- `scripts/setup-wizard/utils/ports.ts` — shared port derivation/validation
- `docker-compose.dev-ports.yml` — dev-only overlay publishing internal service ports

### Files modified

- `libs/tcp-shared/src/config/defaults.ts` — single source of truth for all defaults
- `libs/tcp-shared/src/config/resolve-embedding-dimension.ts` — re-exports DEFAULT_EMBEDDING_DIMENSION from defaults.ts
- `docker-compose.yml` — INTERNAL_URL_* via YAML anchors, EXPOSE_PORT_* port mappings
- `scripts/start-deployment.sh` — URL derivation, port checks, updated required vars
- `scripts/start-dev.sh` — removed .env.defaults reference
- `scripts/check-migrations.sh` — uses derive_host_urls
- `test/support/testcontainers-env.ts` — uses DB_PASSWORD, DB_USER, DB_NAME
- `apps/tcp-server/src/config/config.schema.ts` — imports defaults from defaults.ts
- `apps/tcp-agent/src/config/config.schema.ts` — imports DEFAULT_EMBEDDING_DIMENSION from defaults.ts

### Files removed

- `.env.defaults` — all defaults now live in `defaults.ts`

### Dependencies

- `inquirer` / `@types/inquirer` — interactive prompts for wizard
