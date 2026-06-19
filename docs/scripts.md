# Scripts

All scripts live in [`scripts/`](../scripts/). Each accepts `-h` / `--help`
for full usage. Testing scripts also accept `-- <jest options>` to pass
arguments through to Jest (e.g. `--testNamePattern`, `--testPathPattern`).

## Summary

| Script                                               | Purpose                                                          | Requires              |
| ---------------------------------------------------- | ---------------------------------------------------------------- | --------------------- |
| [start-dev.sh](#start-devsh)                         | Start full environment and configure Keycloak for first-time use | Docker                |
| [stop-dev.sh](#stop-devsh)                           | Stop the dev environment; optionally remove volumes              | Docker                |
| [run-unit-tests.sh](#run-unit-testssh)               | Unit tests                                                       | Nothing               |
| [run-integration-tests.sh](#run-integration-testssh) | Integration tests — service connectivity                         | Docker                |
| [run-system-tests.sh](#run-system-testssh)           | System tests — full stack health checks                          | Docker + built images |
| [run-e2e-tests.sh](#run-e2e-testssh)                 | E2E tests — HTTP API workflows                                   | Docker                |

## start-dev.sh

Starts all Docker Compose services (including Keycloak via `--profile auth`),
waits for each to be healthy, then performs first-time Keycloak configuration:
creates the `lcp` realm, the `lcp-server` confidential client (with
`realm-admin` service account), and a test user.

Safe to re-run — existing Keycloak resources are left untouched.

```bash
./scripts/start-dev.sh                                    # uses .env or .env.testing
./scripts/start-dev.sh -e .env.local                      # custom env file
./scripts/start-dev.sh --test-username alice --test-password s3cret
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
./scripts/stop-dev.sh              # stop, keep data
./scripts/stop-dev.sh --volumes    # stop and reset all data
./scripts/stop-dev.sh -e .env.local --volumes
```

**Options:**

| Flag                 | Description                      | Default                                |
| -------------------- | -------------------------------- | -------------------------------------- |
| `-e`, `--env <path>` | Environment file                 | `.env` if present, else `.env.testing` |
| `-v`, `--volumes`    | Remove volumes (resets all data) | off                                    |

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

## run-system-tests.sh

Starts the full Docker Compose stack including Keycloak (`--profile auth`),
waits for every service to be healthy (up to 5 minutes for Keycloak on first
boot), runs the system suite, then tears down. Tests verify that every health
endpoint returns 200 — lcp-server's `/health` covers PostgreSQL, MinIO, and
OIDC in a single call.

```bash
./scripts/run-system-tests.sh
./scripts/run-system-tests.sh -- --testNamePattern="keycloak"
```

**Requires:** Docker and Docker Compose, `.env.testing`, built app images
(`docker compose build` if images are stale).

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
