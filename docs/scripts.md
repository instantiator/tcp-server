# Scripts

All scripts live in [`scripts/`](../scripts/). Each accepts `-h` / `--help`
for full usage.

Testing scripts also accept `-- <jest options>` to pass
arguments through to Jest (e.g. `--testNamePattern`, `--testPathPattern`).

## Docker Compose project isolation

Each deployment gets a distinct Docker Compose project name so containers,
networks, and volumes are completely independent of each other:

| Launcher                                | Project name             |
| --------------------------------------- | ------------------------ |
| `start-deployment.sh --project tcp-dev` | `tcp-dev`                |
| `start-deployment.sh --project tcp-api` | `tcp-api`                |
| `run-all-tests.sh` (auto-started)       | `tcp-all`                |
| `run-integration-tests.sh`              | `tcp-integration-<pid>`¹ |
| `run-e2e-tests.sh`                      | `tcp-e2e-<pid>`¹         |

A running dev environment is never touched by a test teardown, and test data
never contaminates dev data.

¹ The integration and e2e suites are started by testcontainers from Jest's
global setup, using a per-run project name and **random host ports**. They can
therefore run alongside a dev stack (or each other) without conflict.

> [!WARNING]
> The fixed-port deployments (`tcp-dev`, `tcp-api`, `tcp-all`) all use the same
> host port bindings, so no two of them can run simultaneously on one machine.
> The testcontainers-managed integration/e2e stacks are exempt — they use random
> host ports.

## Summary

| Script                                               | Purpose                                                              | Requires              |
| ---------------------------------------------------- | -------------------------------------------------------------------- | --------------------- |
| [setup-wizard.sh](#setup-wizardsh)                   | Interactive first-time environment configuration                     | Node                  |
| [start-deployment.sh](#start-deploymentsh)           | Start a named Docker Compose stack and bootstrap Zitadel             | Docker                |
| [start-dev.sh](#start-devsh)                         | Start the local dev environment (delegates to `start-deployment.sh`) | Docker                |
| [stop-dev.sh](#stop-devsh)                           | Stop the dev environment; optionally remove volumes                  | Docker                |
| [tcp-cli.sh](#tcp-clish) (repo root)                 | Run the `tcp-cli` tool (builds automatically if needed)              | Built tcp-cli         |
| [run-all-tests.sh](#run-all-testssh)                 | Build, lint, and run every test suite in sequence                    | Docker + built images |
| [run-unit-tests.sh](#run-unit-testssh)               | Unit tests                                                           | Nothing               |
| [run-integration-tests.sh](#run-integration-testssh) | Integration tests — service connectivity                             | Docker                |
| [run-smoke-tests.sh](#run-smoke-testssh)             | Smoke tests — requires a running deployment                          | Running stack         |
| [run-api-tests.sh](#run-api-testssh)                 | API tests — requires a running deployment                            | Running stack         |
| [run-e2e-tests.sh](#run-e2e-testssh)                 | E2E tests — HTTP API workflows                                       | Docker                |
| [run-browser-tests.sh](#run-browser-testssh)         | Browser tests — requires something serving the web app               | Built web app         |
| [manual-verify.sh](#manual-verifysh)                 | Interactive scenario walkthrough with human checks                   | Running stack         |
| [run-stub-llm.sh](#run-stub-llmsh)                   | Run `tcp-stub-llm` from source, for manual testing                   | Node                  |
| [check-migrations.sh](#check-migrationssh)           | Diagnostic report of entity-vs-schema migration drift                | Docker                |

## setup-wizard.sh

Interactive first-time configuration (`npm run setup` runs the same wizard
directly). Asks about the instance name, ports, LLM and embedding providers,
OIDC, and resource limits, then writes a commented `.env.<instance>` plus a
gitignored `.env.<instance>.local` for the secrets. Probes the chosen embedding
model for its dimension, and generates a Docker Compose override when the
answers need one.

```bash
npm run setup              # or: ./scripts/setup-wizard.sh
```

Manual `.env` editing remains a supported fallback — the wizard is a
convenience, not a gate. See
[ADR-018](ADRs/ADR-018-system-configuration-setup-wizard.md).

## start-deployment.sh

The general-purpose stack launcher. Starts infra services (postgres, redis,
minio, and — when the auth profile is active — zitadel) first, then, when
`ZITADEL_ADMIN_PASSWORD` is present in the env file, bootstraps Zitadel via a
machine-user Personal Access Token and the Zitadel REST API: a `tcp` project,
an OIDC application, a human test user, and a machine test user. Only once
that bootstrap has captured Zitadel's server-generated client secrets does it
start the rest of the stack (tcp-server et al) — this ordering matters
because tcp-server needs the real secret at boot, and Zitadel (unlike
Keycloak) won't accept a caller-pre-chosen client secret.

All Zitadel credentials and the test users are read from the env file
(`ZITADEL_ADMIN_PASSWORD`, `TEST_USERNAME`, `TEST_PASSWORD`). No credential
flags are accepted; change those values in the env file instead. See
[docs/zitadel-setup.md](zitadel-setup.md) for the full bootstrap sequence.

Safe to re-run — existing Zitadel resources (project, app, users) are reused,
not recreated. Their client secrets, however, are regenerated on every run and
written to the gitignored `<env-file>.local` override (e.g. `.env.testing.local`),
never the committed base file: a Zitadel secret can only be read at generation
time, so regenerating each run is what keeps the credentials and Zitadel from
silently drifting apart (a stale secret otherwise fails auth with an opaque
`invalid_client`). See [ADR-018 §7](ADRs/ADR-018-system-configuration-setup-wizard.md).

By default the MCP servers and stub-llm are internal-only (not published to the
host); pass `--dev-ports` to publish them for direct access or the smoke tier.

```bash
./scripts/start-deployment.sh --project tcp-dev --env-file .env
./scripts/start-deployment.sh --project tcp-api --env-file .env.testing
./scripts/start-deployment.sh --project tcp-api --env-file .env.testing --rebuild
```

**Options:**

| Flag                | Description                                      | Required |
| ------------------- | ------------------------------------------------ | -------- |
| `--project <name>`  | Docker Compose project name                      | Yes      |
| `--env-file <path>` | Path to env file                                 | Yes      |
| `--rebuild`         | Rebuild images before starting                   | No       |
| `--dev-ports`       | Publish MCP/stub-llm host ports (non-production) | No       |

## start-dev.sh

Thin wrapper around `start-deployment.sh` that fixes the project name to
`tcp-dev` and resolves the env file automatically.

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

Credentials for the Zitadel org admin and test users are read from the env
file (`ZITADEL_ADMIN_PASSWORD`, `TEST_USERNAME`, `TEST_PASSWORD`).

See also: [docs/zitadel-setup.md](zitadel-setup.md) for manual Zitadel
configuration and external IdP setup.

## stop-dev.sh

Stops all services started by `start-dev.sh`. Volumes are kept by default so
data (databases, Zitadel configuration) persists across restarts. Pass
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

`stop-dev.sh` stops the containers immediately, without asking the simulation
to wind down first — an agent mid-LLM-call loses the tokens it has already
spent. To wind down cleanly, drain first with `./tcp-cli.sh shutdown`, which
pauses every running agent at its next resumable point and then runs
`docker compose stop` itself. Use `stop-dev.sh` when nothing is running, when
you want the volumes removed, or when you don't care about the in-flight work.

## tcp-cli.sh

Runs the `tcp-cli` developer tool. Builds the CLI automatically if the
compiled output is missing. Pass `--rebuild` as the first argument to force
a fresh build before running.

```bash
./tcp-cli.sh --help
./tcp-cli.sh list-companies
./tcp-cli.sh --rebuild list-companies
./tcp-cli.sh get-token
./tcp-cli.sh -r <roleId> chat
./tcp-cli.sh -r <roleId> -q "hello" chat
```

The `shutdown` verb is the one case where this wrapper does more than launch
the CLI: once the API reports the simulation drained, the wrapper stops the
`tcp-dev` containers with `docker compose stop`. Halting has to happen here
rather than in the Node process, because every Compose service runs with
`restart: unless-stopped` and would simply be restarted if it exited itself —
see [ADR-019](ADRs/ADR-019-graceful-shutdown.md). Pass `--no-stop` to drain
without halting.

```bash
./tcp-cli.sh shutdown              # drain, wait, then stop the containers
./tcp-cli.sh shutdown --force      # abort in-flight LLM work, then stop
./tcp-cli.sh shutdown --no-stop    # drain only
```

See also: [docs/tcp-cli.md](tcp-cli.md) for the full CLI reference.

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

A thin wrapper around `npm run test:integration`. PostgreSQL, Redis, MinIO, and
the stub-llm service are started (on random host ports) and torn down by Jest's
global setup via testcontainers — the script itself does no Docker
orchestration. Tests verify that the application can connect to and use each
backing service.

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
./scripts/start-deployment.sh --project tcp-smoke --env-file .env.testing
./scripts/run-smoke-tests.sh
docker compose -p tcp-smoke --profile auth down -v

# Remote deployment (no Docker needed)
./scripts/run-smoke-tests.sh --base-url http://your-host:3000
./scripts/run-smoke-tests.sh --base-url http://your-host:3000 \
  --agent-url http://your-host:3001
```

**Options:**

| Flag                       | Env var              | Description             | Default                                                  |
| -------------------------- | -------------------- | ----------------------- | -------------------------------------------------------- |
| `--base-url URL`           | `TCP_SERVER_URL`     | tcp-server base URL     | `http://localhost:3000`                                  |
| `--agent-url URL`          | `TCP_AGENT_URL`      | tcp-agent URL           | `http://localhost:3001`                                  |
| `--oidc-discovery-url URL` | `OIDC_DISCOVERY_URL` | OIDC discovery endpoint | `http://localhost:8080/.well-known/openid-configuration` |

See also: [docs/testing.md](testing.md).

## run-api-tests.sh

Pure test runner — requires a running deployment. Start services first with
`start-deployment.sh`, then run this script. Defaults to
`http://localhost:3000` when `--base-url` is not given.

API tests send authenticated HTTP requests to tcp-server using real
Zitadel-issued JWTs and assert on response shapes and status codes.

Zitadel generates the machine test user's client secret at bootstrap time
(unlike the old fixed `test`/`test` credentials, there's no built-in default
to fall back to), so if `--client-id`/`--client-secret` aren't given and
`TEST_CLIENT_ID`/`TEST_CLIENT_SECRET` aren't already exported, this script
reads them from an env file: `--env-file` if given, else `.env` if present,
else `.env.testing` — checking that file's gitignored `<env-file>.local`
override first, since that's where `start-deployment.sh` writes them.

```bash
# Local: start stack first, then test
./scripts/start-deployment.sh --project tcp-api --env-file .env.testing
./scripts/run-api-tests.sh --env-file .env.testing
docker compose -p tcp-api --profile auth down -v

# Remote deployment (no Docker needed)
./scripts/run-api-tests.sh --base-url http://your-host:3000 \
  --client-id your-client-id --client-secret your-client-secret
```

**Options:**

| Flag                       | Env var              | Description                                        | Default                                                  |
| -------------------------- | -------------------- | -------------------------------------------------- | -------------------------------------------------------- |
| `--base-url URL`           | `TCP_SERVER_URL`     | tcp-server base URL                                | `http://localhost:3000`                                  |
| `--agent-url URL`          | `TCP_AGENT_URL`      | tcp-agent URL                                      | `http://localhost:3001`                                  |
| `--oidc-discovery-url URL` | `OIDC_DISCOVERY_URL` | OIDC discovery endpoint                            | `http://localhost:8080/.well-known/openid-configuration` |
| `--client-id ID`           | `TEST_CLIENT_ID`     | Machine test user client ID (`client_credentials`) | read from env file                                       |
| `--client-secret SECRET`   | `TEST_CLIENT_SECRET` | Machine test user client secret                    | read from env file                                       |
| `--env-file PATH`          | —                    | Env file to read `TEST_CLIENT_ID`/`SECRET` from    | `.env`, else `.env.testing`                              |

`--keycloak-url`/`KEYCLOAK_URL` no longer exists — it's been removed, not
renamed. `--client-id`/`--client-secret` (the machine test user's
credentials, written to the env file by `start-deployment.sh`'s bootstrap)
replace the old username/password ROPC flow for acquiring test tokens.

See also: [docs/testing.md](testing.md).

## run-e2e-tests.sh

A thin wrapper around `npm run test:e2e`. PostgreSQL, Redis, and MinIO are
started (on random host ports) and torn down by Jest's global setup via
testcontainers. The E2E suite runs HTTP requests against a real NestJS
application via `supertest`. Zitadel is not required — auth is mocked
(jwks-rsa).

```bash
./scripts/run-e2e-tests.sh
./scripts/run-e2e-tests.sh -- --testPathPatterns="company"
```

**Requires:** Docker and Docker Compose, `.env.testing` in the repo root.

See also: [docs/testing.md](testing.md).

## run-browser-tests.sh

Pure test runner — like the api and smoke tiers it drives whatever is serving
at `--base-url` and provisions nothing itself. Playwright drives Chromium
against the built bundle and scans each page with axe.

Until 002.03 serves the web app from the deployment, nothing in the compose
stack does, so `playwright.config.ts` starts `vite preview` when nothing
already answers on the base URL. Build the app first, or it serves a stale
`dist/`.

Browser binaries are **not** installed by `npm ci` — they are ~180 MB, and only
this script needs them. It installs Chromium on first use, which is a no-op
afterwards.

```bash
npm run build --workspace apps/frontend/tcp-frontend
./scripts/run-browser-tests.sh

# Against a deployment that already serves the app
./scripts/run-browser-tests.sh --base-url http://localhost:5173

# Pass options through to Playwright
./scripts/run-browser-tests.sh -- --headed
./scripts/run-browser-tests.sh -- --grep "heading"
```

**Options:**

| Flag             | Env var       | Description      | Default                 |
| ---------------- | ------------- | ---------------- | ----------------------- |
| `--base-url URL` | `TCP_WEB_URL` | Web app base URL | `http://localhost:4173` |

See also: [docs/testing.md](testing.md).

## manual-verify.sh

Interactive scenario walkthrough for human-judged verification (response tone,
correct role identification, successful agent-to-agent consultation, live
streamed rendering) that automated tests can't assert on. Creates a test company
and two roles (chicken/cat assistant) from `scripts/test-data/`, then runs each
prompt in `scripts/test-data/manual-verify-scenarios.json` through
`tcp-cli.sh chat -q`, asking the operator a yes/no check after every response.
Output is colourised — blue step headings, yellow questions, a green `Success`
after each passing check, red failures. Halts on the first failed API call or a
check whose answer doesn't match its expected outcome.

Each scenario's `checks` is an array of `{ "question": <string>, "expected":
"y" | "n" }` objects (`expected` defaults to `"y"` when omitted). This lets a
check assert that the correct answer is `"n"` — e.g. "Did any raw event JSON
appear in the output?" should be answered `n` on a healthy run.

```bash
./scripts/start-deployment.sh --project tcp-dev --env-file .env.testing
./scripts/manual-verify.sh
./scripts/manual-verify.sh \
  --tcp-server http://your-host:3000 \
  --scenarios scripts/test-data/manual-verify-scenarios.json
```

Logs in once via `tcp-cli get-token`'s device-flow login (prints a
verification URL/code to complete in a browser) before running any
scenarios, then reuses that token for every call.

**Options:**

| Flag                     | Description         | Default                                          |
| ------------------------ | ------------------- | ------------------------------------------------ |
| `-s, --tcp-server <url>` | TCP server base URL | `http://localhost:3000`                          |
| `--scenarios <file>`     | Scenarios JSON file | `scripts/test-data/manual-verify-scenarios.json` |

**Requires:** a running stack with default LLM config in its `.env`,
`MCP_INTERACTIONS_URL` reachable (the consultation scenario needs it), `jq`.

## run-stub-llm.sh

Runs `apps/tcp-stub-llm` directly from source (no build step — it's plain
TypeScript, run by Node's native type-stripping), for manual testing. See
[tcp-stub-llm](stub-llm.md) for the config format and endpoints.

```bash
./scripts/run-stub-llm.sh --config path/to/config.json --port 3002
```

**Options:**

| Flag              | Description                    | Default |
| ----------------- | ------------------------------ | ------- |
| `--config <path>` | Config file to load on startup | none    |
| `--port <n>`      | Port to listen on              | `3002`  |

**Requires:** Node.

## check-migrations.sh

Reports how the TypeORM entities and the migrated schema differ, by generating a
throwaway migration against a live PostgreSQL and printing it.

**Diagnostic only — never a gate.** Some drift is permanent and expected: the
entities deliberately leave `Date` columns untyped so the same models work
against SQLite, so every `timestamptz` column is reported forever (see
[database.md → Timestamp storage convention](database.md#timestamp-storage-convention)).
pgvector columns and index names drift the same way. Read the output; don't
automate on it.

```bash
./scripts/check-migrations.sh
```

**Requires:** Docker (for a PostgreSQL to diff against).

See also: [docs/db-migrations.md](db-migrations.md).

## run-all-tests.sh

Runs the full verification pipeline in sequence: typecheck → build → lint →
unit → integration → e2e → api → smoke. Each step is delegated to its own
script; a failure at any step aborts the remainder.

If tcp-server is already reachable at `http://localhost:3000` the running
stack is reused for the api and smoke suites. Otherwise, `start-deployment.sh`
starts one automatically from `.env.testing` (project `tcp-all`) and tears it
down on exit.

```bash
./scripts/run-all-tests.sh
```

**Requires:** Docker and Docker Compose, `.env.testing`.

See also: [docs/testing.md](testing.md).
