# Developer setup checklist

Work through this list top-to-bottom on a fresh machine. Each section links to
the relevant documentation where more detail is available.

## 1. Prerequisites

- [ ] **Git** with submodule support (any recent version)
- [ ] **Docker**, running ([Docker Desktop](https://docs.docker.com/get-docker/)
      includes Docker Compose)
- [ ] **jq** and **curl**
- [ ] **Node.js 26.6.0** — `.nvmrc` pins the exact patch release CI uses. With
      [nvm](https://github.com/nvm-sh/nvm) installed, the setup wizard (step 3)
      runs `nvm install` and selects it for you automatically.

## 2. Clone the repository

```bash
git clone --recurse-submodules <repo-url>
cd tcp-server
```

The `--recurse-submodules` flag is required to pull in the `dev-environment`
submodule (coding standards and agent instructions).

If you already cloned without it:

```bash
git submodule update --init --recursive
```

## 3. Run the setup wizard

```bash
./scripts/setup-wizard.sh
```

It installs packages (`npm ci`) when `node_modules` is missing or older than
`package-lock.json`, then asks a few configuration questions — every one has
a default, and `?` shows help. It writes `.env.<instance>` (the default
instance is `dev`, so `.env.dev`) plus a gitignored `.env.<instance>.local`
for the generated secrets (`ZITADEL_MASTERKEY`, `ZITADEL_ADMIN_PASSWORD`,
`TEST_PASSWORD`, and later the OIDC/test client credentials from the Zitadel
bootstrap). See [ADR-018 §7](ADRs/ADR-018-system-configuration-setup-wizard.md)
for the full list.

Re-running the wizard keeps an existing `ZITADEL_MASTERKEY`, wherever it is set
(`.env.<instance>` or `.local`), because Zitadel can't read its database with
a different key. If it finds no key but the instance already has a database,
it asks first: stop, so you can restore the old key, or delete that database
and start fresh.

Manual `.env` editing remains a supported fallback — the wizard is a
convenience, not a gate.

When it asks "Start the stack now?", say yes (the default). It runs
`./scripts/start-dev.sh --env .env.dev --project tcp-dev`, which starts every
service and bootstraps Zitadel with a `tcp` org, project, application, and
test users. On first boot, Docker pulls the base images and npm installs
inside the build — expect this to take several minutes.

Check it's healthy:

```bash
curl http://localhost:3000/health
./scripts/run-smoke-tests.sh
docker compose -p tcp-dev ps
```

| Service         | URL                                |
| --------------- | ---------------------------------- |
| tcp-server API  | <http://localhost:3000>            |
| Swagger UI      | <http://localhost:3000/swagger>    |
| MinIO console   | <http://localhost:9001>            |
| Web app         | <https://localhost:5173>           |
| Zitadel console | <http://localhost:8080/ui/console> |

tcp-agent and the MCP servers are internal-only by default; start with
`./scripts/start-deployment.sh --dev-ports` to publish them.

## 4. Install git hooks

```bash
npm run hooks:install
```

This copies `scripts/hooks/pre-commit` and `scripts/hooks/pre-push`
into `.git/hooks/`. Pre-commit formats, regenerates `schemas/schema.json` and
`docs/licenses.md`, and stages the results into the commit; pre-push re-checks
typecheck/lint/build and migration drift, then runs the unit, integration, and
e2e test tiers — it does not regenerate anything itself. See
[docs/schema.md](schema.md) for more on the schema hook.

A failing hook is reporting a real problem — fix what it says rather than
passing `--no-verify`.

## 5. (Optional) Set up authentication with Zitadel

`start-dev.sh` (step 3) already bootstraps Zitadel automatically — you get a
working `tcp` org, project, application, and test users with no extra steps.

See [docs/zitadel-setup.md](zitadel-setup.md) if you need an external OIDC
provider, or want to do the setup by hand.

## 6. (Optional) Set up for local development without Docker apps

If you want to run tcp-server outside Docker (e.g. for hot reload during
development), start only the infrastructure services:

```bash
docker compose up -d postgres redis minio
npm run start:dev
```

tcp-server falls back to in-memory SQLite when `DATABASE_URL` is absent or
not a postgres URL — useful for quick iteration without any Docker services.

## 7. Run the tests

Confirm your environment is working correctly:

```bash
./scripts/run-unit-tests.sh         # no services required
./scripts/run-integration-tests.sh  # starts postgres, redis, minio
./scripts/run-smoke-tests.sh        # starts full stack including Zitadel
./scripts/run-e2e-tests.sh          # starts postgres, redis, minio
```

All tests should pass. See [docs/testing.md](testing.md) for the full testing
strategy and tier descriptions.

## 8. Adding entities and schema changes

When you add or modify a TypeORM entity, you need to create a migration.
See [docs/db-migrations.md](db-migrations.md) for the step-by-step workflow.

## Done

The system is running. See the [README](../README.md) for a commands reference
and links to further documentation.
