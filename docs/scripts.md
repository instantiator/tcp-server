# Scripts

All scripts live in [`scripts/`](../scripts/). Each accepts `-h` / `--help`
for full usage.

Testing scripts also accept `-- <jest options>` to pass
arguments through to Jest (e.g. `--testNamePattern`, `--testPathPattern`).

## Docker Compose project isolation

Each deployment gets a distinct Docker Compose project name so containers,
networks, and volumes are completely independent of each other:

| Launcher                                | Project name      |
| --------------------------------------- | ----------------- |
| `start-deployment.sh --project lcp-dev` | `lcp-dev`         |
| `start-deployment.sh --project lcp-api` | `lcp-api`         |
| `run-all-tests.sh` (auto-started)       | `lcp-all`         |
| `run-integration-tests.sh`              | `lcp-integration` |
| `run-e2e-tests.sh`                      | `lcp-e2e`         |

A running dev environment is never touched by a test teardown, and test data
never contaminates dev data.

> [!WARNING]
> Port conflicts still prevent two deployments from running simultaneously on the same machine. (They all use the same host port bindings.)

## Summary

| Script                                               | Purpose                                                              | Requires              |
| ---------------------------------------------------- | -------------------------------------------------------------------- | --------------------- |
| [start-deployment.sh](#start-deploymentsh)           | Start a named Docker Compose stack and configure Keycloak            | Docker                |
| [start-dev.sh](#start-devsh)                         | Start the local dev environment (delegates to `start-deployment.sh`) | Docker                |
| [stop-dev.sh](#stop-devsh)                           | Stop the dev environment; optionally remove volumes                  | Docker                |
| [lcp-cli.sh](#lcp-clish) (repo root)                 | Run the `lcp-cli` tool (builds automatically if needed)              | Built lcp-cli         |
| [run-all-tests.sh](#run-all-testssh)                 | Build, lint, and run every test suite in sequence                    | Docker + built images |
| [run-unit-tests.sh](#run-unit-testssh)               | Unit tests                                                           | Nothing               |
| [run-integration-tests.sh](#run-integration-testssh) | Integration tests — service connectivity                             | Docker                |
| [run-smoke-tests.sh](#run-smoke-testssh)             | Smoke tests — requires a running deployment                          | Running stack         |
| [run-api-tests.sh](#run-api-testssh)                 | API tests — requires a running deployment                            | Running stack         |
| [run-e2e-tests.sh](#run-e2e-testssh)                 | E2E tests — HTTP API workflows                                       | Docker                |
| [manual-verify.sh](#manual-verifysh)                 | Interactive scenario walkthrough with human checks                   | Running stack         |

## start-deployment.sh

The general-purpose stack launcher. Starts all Docker Compose services, waits
for each to be healthy, and — when `KEYCLOAK_ADMIN_PASSWORD` is present in the
env file — enables the `auth` profile and configures the Keycloak realm, client,
and test user.

All Keycloak credentials and the test user are read from the env file
(`KEYCLOAK_REALM`, `TEST_USERNAME`, `TEST_PASSWORD`). No credential flags are
accepted; change those values in the env file instead.

Safe to re-run — existing Keycloak resources are left untouched.

```bash
./scripts/start-deployment.sh --project lcp-dev --env-file .env
./scripts/start-deployment.sh --project lcp-api --env-file .env.testing
./scripts/start-deployment.sh --project lcp-api --env-file .env.testing --rebuild
```

**Options:**

| Flag                | Description                    | Required |
| ------------------- | ------------------------------ | -------- |
| `--project <name>`  | Docker Compose project name    | Yes      |
| `--env-file <path>` | Path to env file               | Yes      |
| `--rebuild`         | Rebuild images before starting | No       |

## start-dev.sh

Thin wrapper around `start-deployment.sh` that fixes the project name to
`lcp-dev` and resolves the env file automatically.

```bash
./scripts/start-dev.sh                  # uses .env or .env.testing
./scripts/start-dev.sh -e .env.local    # custom env file
./scripts/start-dev.sh --rebuild        # rebuild images first
```

**Options:**

| Flag                 | Description      | Default                                |
| -------------------- | ---------------- | -------------------------------------- |
| `-e`, `--env <path>` | Environment file | `.env` if present, else `.env.testing` |
| `--rebuild`          | Rebuild images   | off                                    |

Credentials for the Keycloak realm and test user are read from the env file
(`KEYCLOAK_REALM`, `TEST_USERNAME`, `TEST_PASSWORD`).

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

## lcp-cli.sh

Runs the `lcp-cli` developer tool. Builds the CLI automatically if the
compiled output is missing. Pass `--rebuild` as the first argument to force
a fresh build before running.

```bash
./lcp-cli.sh --help
./lcp-cli.sh list-companies
./lcp-cli.sh --rebuild list-companies
./lcp-cli.sh -u alice get-token
./lcp-cli.sh -r <roleId> chat
./lcp-cli.sh -r <roleId> -q "hello" chat
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

Pure test runner — requires a running deployment. Start services first with
`start-deployment.sh`, then run this script. Defaults to
`http://localhost:3000` when `--base-url` is not given.

Smoke tests verify health endpoints across the full stack and the Swagger UI
on every service.

```bash
# Local: start stack first, then test
./scripts/start-deployment.sh --project lcp-smoke --env-file .env.testing
./scripts/run-smoke-tests.sh
docker compose -p lcp-smoke --profile auth down -v

# Remote deployment (no Docker needed)
./scripts/run-smoke-tests.sh --base-url http://your-host:3000
./scripts/run-smoke-tests.sh --base-url http://your-host:3000 \
  --agent-url http://your-host:3001 \
  --username alice --password s3cret
```

**Options:**

| Flag                       | Env var              | Description             | Default                 |
| -------------------------- | -------------------- | ----------------------- | ----------------------- |
| `--base-url URL`           | `LCP_SERVER_URL`     | lcp-server base URL     | `http://localhost:3000` |
| `--agent-url URL`          | `LCP_AGENT_URL`      | lcp-agent URL           | `http://localhost:3001` |
| `--oidc-discovery-url URL` | `OIDC_DISCOVERY_URL` | OIDC discovery endpoint | (Keycloak master realm) |
| `--username NAME`          | `TEST_USERNAME`      | Test user username      | `test`                  |
| `--password PASS`          | `TEST_PASSWORD`      | Test user password      | `test`                  |

See also: [docs/testing.md](testing.md).

## run-api-tests.sh

Pure test runner — requires a running deployment. Start services first with
`start-deployment.sh`, then run this script. Defaults to
`http://localhost:3000` when `--base-url` is not given.

API tests send authenticated HTTP requests to lcp-server using real
Keycloak-issued JWTs and assert on response shapes and status codes.

```bash
# Local: start stack first, then test
./scripts/start-deployment.sh --project lcp-api --env-file .env.testing
./scripts/run-api-tests.sh
docker compose -p lcp-api --profile auth down -v

# Remote deployment (no Docker needed)
./scripts/run-api-tests.sh --base-url http://your-host:3000
./scripts/run-api-tests.sh --base-url http://your-host:3000 \
  --keycloak-url http://your-keycloak:8080 \
  --username alice --password s3cret
```

**Options:**

| Flag                       | Env var              | Description             | Default                 |
| -------------------------- | -------------------- | ----------------------- | ----------------------- |
| `--base-url URL`           | `LCP_SERVER_URL`     | lcp-server base URL     | `http://localhost:3000` |
| `--agent-url URL`          | `LCP_AGENT_URL`      | lcp-agent URL           | `http://localhost:3001` |
| `--keycloak-url URL`       | `KEYCLOAK_URL`       | Keycloak base URL       | `http://localhost:8080` |
| `--oidc-discovery-url URL` | `OIDC_DISCOVERY_URL` | OIDC discovery endpoint | (Keycloak master realm) |
| `--username NAME`          | `TEST_USERNAME`      | Test user username      | `test`                  |
| `--password PASS`          | `TEST_PASSWORD`      | Test user password      | `test`                  |

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

## manual-verify.sh

Interactive scenario walkthrough for human-judged verification (response tone,
correct role identification, successful agent-to-agent consultation, live
streamed rendering) that automated tests can't assert on. Creates a test company
and two roles (chicken/cat assistant) from `scripts/test-data/`, then runs each
prompt in `scripts/test-data/manual-verify-scenarios.json` through
`lcp-cli.sh chat -q`, asking the operator a yes/no check after every response.
Output is colourised — blue step headings, yellow questions, a green `Success`
after each passing check, red failures. Halts on the first failed API call or a
check whose answer doesn't match its expected outcome.

Each scenario's `checks` is an array of `{ "question": <string>, "expected":
"y" | "n" }` objects (`expected` defaults to `"y"` when omitted). This lets a
check assert that the correct answer is `"n"` — e.g. "Did any raw event JSON
appear in the output?" should be answered `n` on a healthy run.

```bash
./scripts/start-deployment.sh --project lcp-dev --env-file .env.testing
./scripts/manual-verify.sh --username test --password test
./scripts/manual-verify.sh --username test --password test \
  --lcp-server http://your-host:3000 \
  --scenarios scripts/test-data/manual-verify-scenarios.json
```

**Options:**

| Flag                     | Description         | Default                                          |
| ------------------------ | ------------------- | ------------------------------------------------ |
| `-u, --username <user>`  | OIDC username       | (required)                                       |
| `-p, --password <pass>`  | OIDC password       | (required)                                       |
| `-s, --lcp-server <url>` | LCP server base URL | `http://localhost:3000`                          |
| `--scenarios <file>`     | Scenarios JSON file | `scripts/test-data/manual-verify-scenarios.json` |

**Requires:** a running stack with default LLM config in its `.env`,
`MCP_INTERACTIONS_URL` reachable (the consultation scenario needs it), `jq`.

## run-all-tests.sh

Runs the full verification pipeline in sequence: typecheck → build → lint →
unit → integration → e2e → api → smoke. Each step is delegated to its own
script; a failure at any step aborts the remainder.

If lcp-server is already reachable at `http://localhost:3000` the running
stack is reused for the api and smoke suites. Otherwise, `start-deployment.sh`
starts one automatically from `.env.testing` (project `lcp-all`) and tears it
down on exit.

```bash
./scripts/run-all-tests.sh
```

**Requires:** Docker and Docker Compose, `.env.testing`.

See also: [docs/testing.md](testing.md).
