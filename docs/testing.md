# Testing

## Strategy

The project uses four test tiers that run in increasing order of scope and
infrastructure requirement. CI runs them in this order — a failure at any tier
gates the next:

```
unit → integration → api (includes smoke) + e2e
```

| Tier        | What it proves                                                                       | Infrastructure                  |
| ----------- | ------------------------------------------------------------------------------------ | ------------------------------- |
| Unit        | Individual classes and functions behave correctly                                    | None — SQLite in-memory         |
| Integration | The app can connect to and use each backing service                                  | Docker (postgres, redis, minio) |
| API         | Health checks, and requests and responses through the lcp-server API with a real JWT | Docker + Zitadel                |
| E2E         | HTTP API workflows produce the right responses end-to-end                            | Docker (postgres, redis, minio) |

**Unit tests** use `better-sqlite3` in-memory and `@nestjs/testing` to wire
modules without starting a real server. They run in milliseconds with no
external dependencies.

**Integration tests** start only the infrastructure services (no app images,
no Zitadel) and verify that the application code can query PostgreSQL, ping
Redis, and reach MinIO. A failure here points to a connectivity or schema
problem, not an application logic problem. The infrastructure is started by
[testcontainers](https://node.testcontainers.org/) from Jest's global setup,
using the project's own `docker-compose.yml` on **random host ports** (see
[Test infrastructure](#test-infrastructure) below), so a run never collides
with a dev stack.

**API tests** require Zitadel and run the full, deployed stack. They first
verify that every `GET /health` endpoint returns 200, then send authenticated
HTTP requests directly to the lcp-server API (using real JWTs) and assert on
response shapes and status codes. Both API and smoke tests are pure black-box
clients: they run against _any_ already-running instance via `--base-url` and
never start, stop, or otherwise manage that instance — so they can target a
local stack, the CI deployment, or a remote environment unchanged. A failure
here points to a deployment, API contract, or authentication issue rather than
an infrastructure problem.

**E2E tests** run HTTP requests against a real NestJS application (via
`supertest`) backed by PostgreSQL, Redis, and MinIO — also started by
testcontainers from Jest's global setup. They test full request/response cycles
including middleware, guards, and TypeORM queries. Zitadel is not required —
auth is mocked (jwks-rsa).

## Running the tests

The integration and e2e suites start their own ephemeral Docker services from
Jest's global setup (via testcontainers) and tear them down automatically; their
runner scripts are thin wrappers around `npm run test:integration`/`test:e2e`.
The api and smoke suites are clients against an already-running stack. All
scripts accept `-- <jest options>` to filter or configure the Jest run.

### All tests

```bash
./scripts/run-all-tests.sh
```

Runs build, lint, and every test suite in order. A failure at any step aborts
the remainder. Requires Docker, `.env.testing`, and built app images (rebuilt
automatically). See [scripts/run-all-tests.sh](../scripts/run-all-tests.sh).

### Unit tests

```bash
./scripts/run-unit-tests.sh
./scripts/run-unit-tests.sh -- --testNamePattern="company"
```

No external services. Safe to run at any time. See
[scripts/run-unit-tests.sh](../scripts/run-unit-tests.sh).

### Integration tests

```bash
./scripts/run-integration-tests.sh
./scripts/run-integration-tests.sh -- --testNamePattern="redis"
```

Jest's global setup starts postgres, redis, minio, and the stub-llm service via
testcontainers (random host ports) and tears them down after the run. Requires
Docker. See [scripts/run-integration-tests.sh](../scripts/run-integration-tests.sh).

### API & smoke tests

Both suites require a running LCP stack with Zitadel. Start one first with
`start-deployment.sh`, then run either or both test scripts against it. In CI
both run against the same stack in the `api-test` job.

```bash
# Start stack (reads Zitadel credentials from env file)
./scripts/start-deployment.sh --project lcp-api --env-file .env.testing

# Run API tests
./scripts/run-api-tests.sh
./scripts/run-api-tests.sh -- --testNamePattern="company"

# Run smoke tests against the same stack
./scripts/run-smoke-tests.sh

# Tear down
docker compose -p lcp-api --profile auth down -v
```

Both scripts default to `http://localhost:3000` and accept `--base-url` to
target a remote deployment without Docker:

```bash
./scripts/run-api-tests.sh --base-url http://your-host:3000 \
  --client-id your-client-id --client-secret your-client-secret

./scripts/run-smoke-tests.sh --base-url http://your-host:3000
```

See [scripts/run-api-tests.sh](../scripts/run-api-tests.sh) and
[scripts/run-smoke-tests.sh](../scripts/run-smoke-tests.sh).

### E2E tests

```bash
./scripts/run-e2e-tests.sh
./scripts/run-e2e-tests.sh -- --testPathPatterns="company"
```

Jest's global setup starts postgres, redis, and minio via testcontainers
(random host ports) and tears them down after the run. Requires Docker. Because
global setup provisions the infrastructure, `npm run test:e2e` (bare jest) works
directly too — it no longer hangs on an unreachable Redis. See
[scripts/run-e2e-tests.sh](../scripts/run-e2e-tests.sh).

## Test infrastructure

The **integration** and **e2e** tiers provision their backing services with
[testcontainers](https://node.testcontainers.org/), driven from Jest
`globalSetup`/`globalTeardown` (`test/integration/global-*.ts`,
`test/e2e/global-*.ts`). The shared helper `test/support/testcontainers-env.ts`
starts the services from the project's own `docker-compose.yml`, so there is one
source of truth for how they are configured.

A small test-only overlay, `test/support/docker-compose.dynamic-ports.yml`,
replaces the fixed host-port bindings with random ones (via the Compose Spec's
`!override` tag). This is what lets a test run coexist with a dev stack — and is
why the runner scripts no longer pause a dev container or probe for
already-running infrastructure.

Required env vars are read via `test/support/require-env.ts`, which throws if a
value is missing rather than letting a spec silently skip. If a container fails
to start, the helper writes each service's logs to
`test-results/<tier>-compose-logs/` (uploaded as a CI artifact on failure) and
raises an error that distinguishes a crash-looping container from a
port-binding failure.

The **api** and **smoke** tiers are unchanged: they use `docker-compose.yml` +
`start-deployment.sh` (including the Zitadel bootstrap) and act purely as
clients against an already-running instance.

## Test file locations

| Suite       | Pattern                                         | Jest config                  |
| ----------- | ----------------------------------------------- | ---------------------------- |
| Unit        | `apps/**/src/**/*.spec.ts`, `libs/**/*.spec.ts` | `jest.config.js` (root)      |
| E2E         | `test/e2e/*.e2e-spec.ts`                        | `test/jest-e2e.json`         |
| Integration | `test/integration/**/*.integration-spec.ts`     | `test/jest-integration.json` |
| Smoke       | `test/smoke/**/*.spec.ts`                       | `test/jest-smoke.json`       |
| API         | `test/api/**/*.spec.ts`                         | `test/jest-api.json`         |

## CI pipeline

Tests run in the same order in CI (see `.github/workflows/ci.yml`). Build and
lint run in parallel first; each subsequent tier only runs if the previous
passed.

```
verify (build + lint + typecheck) → unit-test → integration-test ─┬─→ api-test (includes smoke)
                                                                   └─→ e2e-test
```
