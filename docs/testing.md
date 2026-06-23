# Testing

## Strategy

The project uses four test tiers that run in increasing order of scope and
infrastructure requirement. CI runs them in this order — a failure at any tier
gates the next:

```
unit → integration → api (includes smoke) + e2e
```

| Tier        | What it proves                                                                 | Infrastructure                  |
| ----------- | ------------------------------------------------------------------------------ | ------------------------------- |
| Unit        | Individual classes and functions behave correctly                              | None — SQLite in-memory         |
| Integration | The app can connect to and use each backing service                            | Docker (postgres, redis, minio) |
| API         | Health checks, and requests and responses through the lcp-server API with a real JWT | Docker + Keycloak         |
| E2E         | HTTP API workflows produce the right responses end-to-end                      | Docker (postgres, redis, minio) |

**Unit tests** use `better-sqlite3` in-memory and `@nestjs/testing` to wire
modules without starting a real server. They run in milliseconds with no
external dependencies.

**Integration tests** start only the infrastructure services (no app images,
no Keycloak) and verify that the application code can query PostgreSQL, ping
Redis, and reach MinIO. A failure here points to a connectivity or schema
problem, not an application logic problem.

**API tests** require Keycloak and run the full stack. They first verify that
every `GET /health` endpoint returns 200, then send authenticated HTTP requests
directly to the lcp-server API (using real JWTs) and assert on response shapes
and status codes. Smoke tests can still be run independently against a remote
deployment via `run-smoke-tests.sh`. A failure here points to a deployment,
API contract, or authentication issue rather than an infrastructure problem.

**E2E tests** run HTTP requests against a real NestJS application (via
`supertest`) backed by PostgreSQL. They test full request/response cycles
including middleware, guards, and TypeORM queries. Keycloak is not required —
OIDC env vars are set as stubs.

## Running the tests

Each script manages its own Docker services and tears them down on exit.
All scripts accept `-- <jest options>` to filter or configure the Jest run.

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

Starts postgres, redis, and minio. Requires Docker. See
[scripts/run-integration-tests.sh](../scripts/run-integration-tests.sh).

### Smoke tests

Smoke tests run as part of the API test suite in CI (see below). To run
them in isolation — for example against a remote deployment — use:

```bash
./scripts/run-smoke-tests.sh

# Remote deployment — Docker not required
./scripts/run-smoke-tests.sh --base-url http://your-host:3000
./scripts/run-smoke-tests.sh --base-url http://your-host:3000 \
  --agent-url http://your-host:3001 \
  --keycloak-url http://your-keycloak:8080 \
  --username alice --password s3cret
```

Accepts `--base-url` to test a remote deployment without Docker. See
[scripts/run-smoke-tests.sh](../scripts/run-smoke-tests.sh).

### API tests

```bash
./scripts/run-api-tests.sh
./scripts/run-api-tests.sh -- --testNamePattern="company"

# Remote deployment — Docker not required
./scripts/run-api-tests.sh --base-url http://your-host:3000
./scripts/run-api-tests.sh --base-url http://your-host:3000 \
  --keycloak-url http://your-keycloak:8080 \
  --username alice --password s3cret
```

Starts the full stack including Keycloak. Requires Docker and built app
images (rebuilt automatically). Accepts `--base-url` to test a remote
deployment — same flag semantics as the smoke script above. See
[scripts/run-api-tests.sh](../scripts/run-api-tests.sh).

### E2E tests

```bash
./scripts/run-e2e-tests.sh
./scripts/run-e2e-tests.sh -- --testPathPattern="company"
```

Starts postgres, redis, and minio. Requires Docker. See
[scripts/run-e2e-tests.sh](../scripts/run-e2e-tests.sh).

## Test file locations

| Suite       | Pattern                                          | Jest config                  |
| ----------- | ------------------------------------------------ | ---------------------------- |
| Unit        | `apps/**/src/**/*.spec.ts`, `libs/**/*.spec.ts`  | `jest.config.js` (root)      |
| E2E         | `test/e2e/*.e2e-spec.ts`                         | `test/jest-e2e.json`         |
| Integration | `test/integration/**/*.integration-spec.ts`      | `test/jest-integration.json` |
| Smoke       | `test/smoke/**/*.spec.ts`                        | `test/jest-smoke.json`       |
| API         | `test/api/**/*.spec.ts`                          | `test/jest-api.json`         |

## CI pipeline

Tests run in the same order in CI (see `.github/workflows/ci.yml`). Build and
lint run in parallel first; each subsequent tier only runs if the previous
passed.

```
verify (build + lint + typecheck) → unit-test → integration-test ─┬─→ api-test (includes smoke)
                                                                   └─→ e2e-test
```
