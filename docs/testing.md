# Testing

## Strategy

The project uses four test tiers that run in increasing order of scope and
infrastructure requirement. CI runs them in this order — a failure at any tier
gates the next:

```
unit → integration → smoke → e2e
```

| Tier        | What it proves                                                                 | Infrastructure                  |
| ----------- | ------------------------------------------------------------------------------ | ------------------------------- |
| Unit        | Individual classes and functions behave correctly                              | None — SQLite in-memory         |
| Integration | The app can connect to and use each backing service                            | Docker (postgres, redis, minio) |
| Smoke       | The full deployment starts and health checks pass                              | Docker + Keycloak               |
| API         | Requests and responses through the lcp-server API with a real JWT              | Docker + Keycloak               |
| E2E         | HTTP API workflows produce the right responses end-to-end                      | Docker (postgres, redis, minio) |

**Unit tests** use `better-sqlite3` in-memory and `@nestjs/testing` to wire
modules without starting a real server. They run in milliseconds with no
external dependencies.

**Integration tests** start only the infrastructure services (no app images,
no Keycloak) and verify that the application code can query PostgreSQL, ping
Redis, and reach MinIO. A failure here points to a connectivity or schema
problem, not an application logic problem.

**Smoke tests** start the full Docker Compose stack including Keycloak and
verify that every `GET /health` endpoint returns 200. Keycloak can take up to
5 minutes on first boot.

**API tests** also require Keycloak and run the full stack. They send
authenticated HTTP requests directly to the lcp-server API (using real JWTs)
and assert on response shapes and status codes. A failure here points to API
contract or authentication issues rather than infrastructure problems.

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

```bash
./scripts/run-smoke-tests.sh
./scripts/run-smoke-tests.sh -- --testNamePattern="get-token"

# Remote deployment — Docker not required
./scripts/run-smoke-tests.sh --base-url http://your-host:3000
./scripts/run-smoke-tests.sh --base-url http://your-host:3000 \
  --agent-url http://your-host:3001 \
  --keycloak-url http://your-keycloak:8080 \
  --username alice --password s3cret
```

Starts the full stack including Keycloak. Requires Docker and built app
images (rebuilt automatically). Accepts `--base-url` to test a remote
deployment instead — in that mode Docker is not used and credentials/URLs
for the remote stack are supplied via the flags above (or as environment
variables `LCP_AGENT_URL`, `KEYCLOAK_URL`, `TEST_USERNAME`, `TEST_PASSWORD`).
See [scripts/run-smoke-tests.sh](../scripts/run-smoke-tests.sh).

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
build ─┐
       ├─→ unit-test → integration-test → smoke-test ─┬─→ api-test
lint  ─┘                                              └─→ e2e-test
```
