# Testing

## Strategy

The project uses four test tiers that run in increasing order of scope and
infrastructure requirement. CI runs them in this order — a failure at any tier
gates the next:

```
unit → integration → smoke → e2e
```

| Tier        | What it proves                                            | Infrastructure                  |
| ----------- | --------------------------------------------------------- | ------------------------------- |
| Unit        | Individual classes and functions behave correctly         | None — SQLite in-memory         |
| Integration | The app can connect to and use each backing service       | Docker (postgres, redis, minio) |
| Smoke       | The full deployment starts, health checks pass, and the lcp-cli API flows work | Docker + Keycloak |
| E2E         | HTTP API workflows produce the right responses end-to-end | Docker (postgres, redis, minio) |

**Unit tests** use `better-sqlite3` in-memory and `@nestjs/testing` to wire
modules without starting a real server. They run in milliseconds with no
external dependencies.

**Integration tests** start only the infrastructure services (no app images,
no Keycloak) and verify that the application code can query PostgreSQL, ping
Redis, and reach MinIO. A failure here points to a connectivity or schema
problem, not an application logic problem.

**Smoke tests** start the full Docker Compose stack including Keycloak and
verify that every `GET /health` endpoint returns 200. They also exercise the
full API surface used by `lcp-cli`: obtaining a token from the OIDC proxy,
creating and listing companies and roles, and creating/deleting chat agents.
Keycloak can take up to 5 minutes on first boot.

**E2E tests** run HTTP requests against a real NestJS application (via
`supertest`) backed by PostgreSQL. They test full request/response cycles
including middleware, guards, and TypeORM queries. Keycloak is not required —
OIDC env vars are set as stubs.

## Running the tests

Each script manages its own Docker services and tears them down on exit.
All scripts accept `-- <jest options>` to filter or configure the Jest run.

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
./scripts/run-smoke-tests.sh --base-url http://your-host:3000   # remote deployment
```

Starts the full stack including Keycloak. Requires Docker and built app
images (rebuilt automatically). Also accepts `--base-url` to test a remote
deployment (no Docker required in that mode). See
[scripts/run-smoke-tests.sh](../scripts/run-smoke-tests.sh).

### E2E tests

```bash
./scripts/run-e2e-tests.sh
./scripts/run-e2e-tests.sh -- --testPathPattern="company"
```

Starts postgres, redis, and minio. Requires Docker. See
[scripts/run-e2e-tests.sh](../scripts/run-e2e-tests.sh).

## Test file locations

| Suite       | Pattern                                             | Jest config                          |
| ----------- | --------------------------------------------------- | ------------------------------------ |
| Unit        | `apps/**/src/**/*.spec.ts`, `libs/**/*.spec.ts`     | `jest.config.js` (root)              |
| E2E         | `apps/**/test/**/*.e2e-spec.ts`                     | `apps/lcp-server/test/jest-e2e.json` |
| Integration | `apps/**/test/integration/**/*.integration-spec.ts` | `test/jest-integration.json`         |
| Smoke       | `test/smoke/**/*.spec.ts`                           | `test/jest-smoke.json`               |

## CI pipeline

Tests run in the same order in CI (see `.github/workflows/ci.yml`). Build and
lint run in parallel first; each subsequent tier only runs if the previous
passed.

```
build ─┐
       ├─→ unit-test → integration-test → smoke-test → e2e-test
lint  ─┘
```
