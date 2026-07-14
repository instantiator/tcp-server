# Developer setup checklist

Work through this list top-to-bottom on a fresh machine. Each section links to
the relevant documentation where more detail is available.

## 1. Prerequisites

- [ ] **Docker** and **Docker Compose** installed
      ([Docker Desktop](https://docs.docker.com/get-docker/) includes both)
- [ ] **Node.js 24 LTS** and npm installed ([nodejs.org](https://nodejs.org/))
- [ ] **Git** with submodule support (any recent version)

## 2. Clone the repository

```bash
git clone --recurse-submodules <repo-url>
cd lcp-server
```

The `--recurse-submodules` flag is required to pull in the `dev-environment`
submodule (coding standards and agent instructions).

If you already cloned without it:

```bash
git submodule update --init --recursive
```

## 3. Install dependencies and git hooks

```bash
npm install
npm run hooks:install
```

The second command copies `scripts/hooks/pre-commit` and `scripts/hooks/pre-push`
into `.git/hooks/`. Pre-commit formats, regenerates `schemas/schema.json` and
`docs/licenses.md`, and stages the results into the commit; pre-push re-checks
typecheck/lint/build and migration drift, then runs the unit, integration, and
e2e test tiers — it does not regenerate anything itself. See
[docs/schema.md](schema.md) for more on the schema hook, and bypass either
hook with `--no-verify` when needed.

## 4. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and review each value. The defaults work out of the box for local
development with Docker Compose. Values you may want to change:

| Variable                                | Default        | When to change                          |
| --------------------------------------- | -------------- | --------------------------------------- |
| `POSTGRES_PASSWORD`                     | `dev-password` | Any shared or non-local environment     |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | stub values    | Any shared or non-local environment     |
| `OIDC_CLIENT_SECRET`                    | `change-me`    | Required when running Keycloak (step 7) |
| `KEYCLOAK_ADMIN_PASSWORD`               | `admin`        | Required when running Keycloak (step 7) |

The OIDC variables (`OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`)
must be set but are not validated at startup unless a guarded endpoint is called.
The defaults from `.env.example` are safe to leave for development without auth.

## 5. Start all services

```bash
docker compose up -d
```

This starts PostgreSQL, Redis, and MinIO. lcp-server and lcp-agent are built
and started from the Docker images.

On first boot, Docker pulls the base images and npm installs inside the build —
expect this to take several minutes.

## 6. Verify services are healthy

```bash
curl http://localhost:3000/health   # lcp-server: database + MinIO + OIDC
curl http://localhost:3001/health   # lcp-agent
```

Both should return HTTP 200. If lcp-server returns 503, check
`docker compose logs lcp-server` — the most common cause is a dependency
(PostgreSQL or MinIO) that hasn't finished starting yet. Wait 10–20 seconds
and retry.

| Service        | URL                   |
| -------------- | --------------------- |
| lcp-server API | http://localhost:3000 |
| lcp-agent      | http://localhost:3001 |
| MinIO console  | http://localhost:9001 |

## 7. (Optional) Set up authentication with Keycloak

Skip this step for development work that doesn't require authenticated endpoints.

```bash
docker compose --profile auth up -d
```

Then follow [docs/keycloak-setup.md](keycloak-setup.md) to create the realm,
client, and initial users.

## 8. (Optional) Set up for local development without Docker apps

If you want to run lcp-server outside Docker (e.g. for hot reload during
development), start only the infrastructure services:

```bash
docker compose up -d postgres redis minio
npm run start:dev
```

lcp-server falls back to in-memory SQLite when `DATABASE_URL` is absent or
not a postgres URL — useful for quick iteration without any Docker services.

## 9. Run the tests

Confirm your environment is working correctly:

```bash
./scripts/run-unit-tests.sh         # no services required
./scripts/run-integration-tests.sh  # starts postgres, redis, minio
./scripts/run-smoke-tests.sh        # starts full stack including Keycloak
./scripts/run-e2e-tests.sh          # starts postgres, redis, minio
```

All tests should pass. See [docs/testing.md](testing.md) for the full testing
strategy and tier descriptions.

## 10. Adding entities and schema changes

When you add or modify a TypeORM entity, you need to create a migration.
See [docs/db-migrations.md](db-migrations.md) for the step-by-step workflow.

## Done

The system is running. See the [README](../README.md) for a commands reference
and links to further documentation.
