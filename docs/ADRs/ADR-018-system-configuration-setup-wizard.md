# ADR-018: System Configuration and Setup Wizard

Status: Proposed

## Context

LCP Server currently requires manual configuration of environment variables, with limited guidance for new deployments. Key pain points:

1. **No structured first-time setup** — users must manually edit `.env` files, consult documentation, and understand the relationship between services (PostgreSQL, Redis, MinIO, OIDC, LLM providers).

2. **Fixed embedding dimensions** — the vector database columns are hardcoded to `vector(768)`. Changing the embedding model later requires manual migration and re-indexing of all scopes, with no tooling to assist.

3. **Single `.env` file assumption** — while the apps technically support any env file (loaded by deployment scripts), there's no established pattern for multi-environment configs (dev, testing, production) with sensible defaults.

4. **No validation before startup** — misconfigured LLM endpoints or embedding models cause runtime failures rather than being caught at setup time.

The goal is to provide:

- A setup wizard that guides users through initial configuration
- Configurable embedding dimensions with automatic migration
- Layered environment files with clear precedence
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

### 1. Multi-file environment with precedence

Env files live in the project root. Layered precedence allows environment-specific overrides with fallback defaults:

```
Development:   .env.dev → .env.defaults
Testing:       .env.testing → .env.defaults
Production:    .env.prod → .env.defaults
```

No code reads `.env` directly. Apps receive a fully populated `process.env` before startup. Deployment scripts (`start-deployment.sh`) and test harnesses (`testcontainers-env.ts`) are responsible for loading the appropriate file chain.

**New env vars:**

- `LCP_ENV_FILES` — comma-separated list of env files in precedence order (e.g., `.env.dev,.env.defaults`). If unset, defaults are determined by the deployment script.

### 2. Configurable embedding dimension

A new env var `EMBEDDING_DIMENSION` (default: 768) controls the vector column width. On startup, lcp-server compares this value against the actual database schema:

- **If unchanged**: no action
- **If changed**: prompt user for confirmation, then:
  1. Generate a migration to drop and recreate `knowledge_chunk.embedding` and `episodic_memory.embedding` columns at the new dimension
  2. Drop and recreate the IVFFlat indexes
  3. Trigger a full re-index of all knowledge scopes

This eliminates the need for manual migration expertise when switching embedding models.

### 3. Setup wizard

A standalone Node/TypeScript script using `inquirer`, invoked via:

- `npm run setup` (builds and runs)
- `./scripts/setup-wizard.sh` (pre-built wrapper)

**Wizard flow:**

1. **Instance configuration**
   - "What is the name of this instance? (default: lcp-dev)"
   - "What is the name of the .env file to hold this configuration? (default: .env.dev)"

2. **LLM configuration (optional)**
   - "Do you wish to provide LLM configuration at application level for an embedding model? (y/n)"
   - If yes → sub-questions: provider, model, base URL, API key
   - Validate: probe endpoint, send test embedding, confirm dimension
   - Allow skip: "Model not available yet? Store config without validation? (y/n)"

   - "Do you wish to provide LLM configuration at application level for an inference model? (y/n)"
   - If yes → sub-questions: provider, model, base URL, API key, context window
   - Validate: send test chat completion
   - Allow skip option

3. **Authentication configuration (optional)**
   - "Will you be using a third party OIDC authentication provider? (y/n)"
   - If yes → sub-questions: issuer URL, client ID, client secret
   - If no → configure stub OIDC for local dev

4. **Resource limits**
   - "What is the maximum number of iterations an agent can perform? (default: 40)"
   - "What is the maximum number of concurrent agents? (default: 5)"

5. **Docker Compose configuration**
   - "Which services do you want to run? (default: all)"
   - Options: PostgreSQL, Redis, MinIO, Zitadel (OIDC), stub-llm
   - Generate `docker-compose.override.yml` with selected services and custom ports

6. **Summary and write**
   - Display generated config
   - Write `.env.<instance>` with explanatory comments
   - Write `docker-compose.override.yml` if Docker config changed
   - Print next steps

### 4. Set embedding model script

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

## Consequences

### Makes easier

- First-time deployment setup for new users
- Changing embedding models without deep PostgreSQL expertise
- Running multiple instances (dev, testing, prod) with different configs
- Validating LLM configuration before deploying

### Makes harder

- Migration safety (auto-detect adds complexity, requires confirmation flow)
- Testing the wizard itself (interactive prompts need mocking or snapshot testing)
- Documentation (must explain the layered env system and when to use which file)

### Risks

- Wizard may not cover edge cases in initial version (mitigate: allow manual `.env` editing as fallback)
- Auto-migration could fail on large datasets (mitigate: confirmation prompt, manual fallback instructions)

## Open Questions

- Should the wizard support `--non-interactive` mode for CI/automated setup?
- Should generated env files be gitignored by default (`.env.*` pattern)?
- How to handle wizard version compatibility with existing `.env` files?

## Implementation Notes

### Files to create

- `scripts/setup-wizard/` — wizard source directory
- `scripts/setup-wizard/index.ts` — main entry point
- `scripts/setup-wizard/prompts/` — question modules
- `scripts/set-embedding-model.ts` — standalone embedding model script
- `scripts/setup-wizard.sh` — shell wrapper for wizard
- `scripts/set-embedding-model.sh` — shell wrapper for embedding script

### Files to modify

- `apps/lcp-server/src/app.module.ts` — add dimension check on startup
- `apps/lcp-server/src/migrations-list.ts` — register new migration
- `package.json` — add `setup` and `set-embedding-model` scripts
- `.gitignore` — add `.env.*` pattern (except `.env.example`)

### New dependencies

- `inquirer` — interactive prompts for wizard
