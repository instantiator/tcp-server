# Scripts

All scripts live in [`scripts/`](../scripts/). Each accepts `-h` / `--help`
for full usage. Testing scripts also accept `-- <jest options>` to pass
arguments through to Jest (e.g. `--testNamePattern`, `--testPathPattern`).

## Docker Compose project isolation

Each script uses a distinct Docker Compose project name so their containers,
networks, and volumes are completely independent of each other:

| Script                     | Project name      |
| -------------------------- | ----------------- |
| `dev/start-dev.sh`         | `lcp-dev`         |
| `run-integration-tests.sh` | `lcp-integration` |
| `run-e2e-tests.sh`         | `lcp-e2e`         |
| `run-smoke-tests.sh`       | `lcp-smoke`       |
| `run-api-tests.sh`         | `lcp-api`         |

This means a running dev environment is never touched by a test script's
`down`, and test data never contaminates dev data. Port conflicts still
prevent two deployments from running simultaneously on the same machine
(all use the same host port bindings).

## Summary

| Script                                               | Purpose                                                            | Requires              |
| ---------------------------------------------------- | ------------------------------------------------------------------ | --------------------- |
| [dev/start-dev.sh](#start-devsh)                     | Start full environment and configure Keycloak for first-time use   | Docker                |
| [dev/stop-dev.sh](#stop-devsh)                       | Stop the dev environment; optionally remove volumes                | Docker                |
| [dev/lcp-cli.sh](#lcp-clish)                         | Run the `lcp-cli` tool (builds automatically if needed)            | Built lcp-cli         |
| [run-all-tests.sh](#run-all-testssh)                 | Build, lint, and run every test suite in sequence                  | Docker + built images |
| [run-unit-tests.sh](#run-unit-testssh)               | Unit tests                                                         | Nothing               |
| [run-integration-tests.sh](#run-integration-testssh) | Integration tests — service connectivity                           | Docker                |
| [run-smoke-tests.sh](#run-smoke-testssh)             | Smoke tests — full stack health checks                             | Docker + built images |
| [run-api-tests.sh](#run-api-testssh)                 | API tests — authenticated HTTP requests against the lcp-server API | Docker + built images |
| [run-e2e-tests.sh](#run-e2e-testssh)                 | E2E tests — HTTP API workflows                                     | Docker                |

## start-dev.sh

Starts all Docker Compose services (including Keycloak via `--profile auth`),
waits for each to be healthy, then performs first-time Keycloak configuration:
creates the `lcp` realm, the `lcp-server` confidential client (with
`realm-admin` service account), and a test user.

Safe to re-run — existing Keycloak resources are left untouched.

```bash
./scripts/dev/start-dev.sh                                    # uses .env or .env.testing
./scripts/dev/start-dev.sh -e .env.local                      # custom env file
./scripts/dev/start-dev.sh --test-username alice --test-password s3cret
```

**Options:**

| Flag                     | Description            | Default                                |
| ------------------------ | ---------------------- | -------------------------------------- |
| `-e`, `--env <path>`     | Environment file       | `.env` if present, else `.env.testing` |
| `--test-username <name>` | Keycloak test user     | `test`                                 |
| `--test-password <pass>` | Keycloak test password | `test`                                 |

See also: [docs/keycloak-setup.md](keycloak-setup.md) for manual Keycloak
configuration and external IdP setup.

## stop-dev.sh

Stops all services started by `start-dev.sh`. Volumes are kept by default so
data (databases, Keycloak configuration) persists across restarts. Pass
`--volumes` to reset everything to a clean state.

```bash
./scripts/dev/stop-dev.sh              # stop, keep data
./scripts/dev/stop-dev.sh --volumes    # stop and reset all data
./scripts/dev/stop-dev.sh -e .env.local --volumes
```

**Options:**

| Flag                 | Description                      | Default                                |
| -------------------- | -------------------------------- | -------------------------------------- |
| `-e`, `--env <path>` | Environment file                 | `.env` if present, else `.env.testing` |
| `-v`, `--volumes`    | Remove volumes (resets all data) | off                                    |

## lcp-cli.sh

Runs the `lcp-cli` developer tool. Builds the CLI automatically if the
compiled output is missing. Pass `--rebuild` as the first argument to force
a fresh build before running.

```bash
./scripts/dev/lcp-cli.sh --help
./scripts/dev/lcp-cli.sh list-companies
./scripts/dev/lcp-cli.sh --rebuild list-companies
./scripts/dev/lcp-cli.sh -u alice get-token
./scripts/dev/lcp-cli.sh -r <roleId> chat
./scripts/dev/lcp-cli.sh -r <roleId> -q "hello" chat
```

See also: [docs/lcp-cli.md](lcp-cli.md) for the full CLI reference.

## run-unit-tests.sh

Runs the unit test suite. No external services required — tests use
`better-sqlite3` in-memory. The fastest feedback loop; run this continuously
during development.

```bash
./scripts/run-unit-tests.sh
./scripts/run-unit-tests.sh -- --testNamePattern="company"
./scripts/run-unit-tests.sh -- --testPathPattern="api"
```

See also: [docs/testing.md](testing.md) for the full testing strategy.

## run-integration-tests.sh

Starts PostgreSQL, Redis, and MinIO via Docker Compose, waits for each to be
healthy, runs the integration suite, then tears down the containers. Tests
verify that the application can connect to and use each backing service.

```bash
./scripts/run-integration-tests.sh
./scripts/run-integration-tests.sh -- --testNamePattern="redis"
```

**Requires:** Docker and Docker Compose, `.env.testing` in the repo root.

See also: [docs/testing.md](testing.md).

## run-smoke-tests.sh

Starts the full Docker Compose stack including Keycloak (`--profile auth`),
configures the `lcp` realm, client, and test user, waits for every service to
be healthy (up to 5 minutes for Keycloak on first boot), runs the smoke suite,
then tears down. Tests verify health endpoints and the full API surface used by
`lcp-cli` (token acquisition, company/role CRUD, chat agent lifecycle).

Accepts `--base-url URL` to skip Docker entirely and test a remote deployment.
When using `--base-url`, supply credentials and service URLs via the flags
below or as environment variables.

```bash
./scripts/run-smoke-tests.sh
./scripts/run-smoke-tests.sh -- --testNamePattern="get-token"

# Remote deployment
./scripts/run-smoke-tests.sh --base-url http://your-host:3000
./scripts/run-smoke-tests.sh --base-url http://your-host:3000 \
  --agent-url http://your-host:3001 \
  --keycloak-url http://your-keycloak:8080 \
  --username alice --password s3cret
```

**Options:**

| Flag                 | Env var         | Description                      | Default                 |
| -------------------- | --------------- | -------------------------------- | ----------------------- |
| `--base-url URL`     | —               | Test against a remote deployment | (local Docker mode)     |
| `--agent-url URL`    | `LCP_AGENT_URL` | lcp-agent URL (remote mode)      | `http://localhost:3001` |
| `--keycloak-url URL` | `KEYCLOAK_URL`  | Keycloak URL (remote mode)       | `http://localhost:8080` |
| `--username NAME`    | `TEST_USERNAME` | Test user username (remote mode) | `test`                  |
| `--password PASS`    | `TEST_PASSWORD` | Test user password (remote mode) | `test`                  |

**Requires (local mode):** Docker and Docker Compose, `.env.testing`, app
images (rebuilt automatically).

See also: [docs/testing.md](testing.md).

## run-api-tests.sh

Starts the full Docker Compose stack including Keycloak (`--profile auth`),
configures the `lcp` realm, client, and test user, waits for every service to
be healthy, runs the API test suite, then tears down. Tests send authenticated
HTTP requests directly to the lcp-server API using real Keycloak-issued JWTs
and assert on response shapes and status codes.

Accepts `--base-url URL` to skip Docker entirely and test a remote deployment.
When using `--base-url`, supply credentials and service URLs via the flags
below or as environment variables. CLI flags take precedence over environment
variables.

```bash
./scripts/run-api-tests.sh
./scripts/run-api-tests.sh -- --testNamePattern="company"

# Remote deployment
./scripts/run-api-tests.sh --base-url http://your-host:3000
./scripts/run-api-tests.sh --base-url http://your-host:3000 \
  --keycloak-url http://your-keycloak:8080 \
  --username alice --password s3cret
```

**Options:**

| Flag                 | Env var         | Description                      | Default                 |
| -------------------- | --------------- | -------------------------------- | ----------------------- |
| `--base-url URL`     | —               | Test against a remote deployment | (local Docker mode)     |
| `--agent-url URL`    | `LCP_AGENT_URL` | lcp-agent URL (remote mode)      | `http://localhost:3001` |
| `--keycloak-url URL` | `KEYCLOAK_URL`  | Keycloak URL (remote mode)       | `http://localhost:8080` |
| `--username NAME`    | `TEST_USERNAME` | Test user username (remote mode) | `test`                  |
| `--password PASS`    | `TEST_PASSWORD` | Test user password (remote mode) | `test`                  |

**Requires (local mode):** Docker and Docker Compose, `.env.testing`, app
images (rebuilt automatically).

See also: [docs/testing.md](testing.md).

## run-e2e-tests.sh

Starts PostgreSQL, Redis, and MinIO via Docker Compose, runs the E2E suite
(HTTP requests against a real NestJS application via `supertest`), then tears
down. Keycloak is not required — OIDC env vars are provided as stubs.

```bash
./scripts/run-e2e-tests.sh
./scripts/run-e2e-tests.sh -- --testPathPattern="company"
```

**Requires:** Docker and Docker Compose, `.env.testing` in the repo root.

See also: [docs/testing.md](testing.md).

## run-all-tests.sh

Runs the full verification pipeline in sequence: build → lint → unit →
integration → e2e → api → smoke. Each step is delegated to its own script;
a failure in any step aborts the remainder.

```bash
./scripts/run-all-tests.sh
```

**Requires:** Docker and Docker Compose, `.env.testing`, and built app images
(rebuilt automatically by the smoke and api scripts).

See also: [docs/testing.md](testing.md).
