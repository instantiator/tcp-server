# Testing

## Strategy

The project uses four test tiers that run in increasing order of scope and
infrastructure requirement. CI runs them in this order — a failure at any tier
gates the next:

```
unit → integration → system → e2e
```

| Tier        | What it proves                                            | Infrastructure                  |
| ----------- | --------------------------------------------------------- | ------------------------------- |
| Unit        | Individual classes and functions behave correctly         | None — SQLite in-memory         |
| Integration | The app can connect to and use each backing service       | Docker (postgres, redis, minio) |
| System      | The full deployment starts and all health checks pass     | Docker + Keycloak               |
| E2E         | HTTP API workflows produce the right responses end-to-end | Docker (postgres, redis, minio) |

**Unit tests** use `better-sqlite3` in-memory and `@nestjs/testing` to wire
modules without starting a real server. They run in milliseconds with no
external dependencies.

**Integration tests** start only the infrastructure services (no app images,
no Keycloak) and verify that the application code can query PostgreSQL, ping
Redis, and reach MinIO. A failure here points to a connectivity or schema
problem, not an application logic problem.

**System tests** start the full Docker Compose stack including Keycloak and
verify that every `GET /health` endpoint returns 200. lcp-server's health
check covers PostgreSQL, MinIO, and OIDC reachability in a single call, so a
passing system test confirms the entire stack is wired correctly. Keycloak can
take up to 5 minutes on first boot.

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

### System tests

```bash
./scripts/run-system-tests.sh
./scripts/run-system-tests.sh -- --testNamePattern="keycloak"
```

Starts the full stack including Keycloak. Requires Docker and built app
images (`docker compose build` if they are stale). See
[scripts/run-system-tests.sh](../scripts/run-system-tests.sh).

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
| System      | `test/system/**/*.spec.ts`                          | `test/jest-system.json`              |

## CI pipeline

Tests run in the same order in CI (see `.github/workflows/ci.yml`). Build and
lint run in parallel first; each subsequent tier only runs if the previous
passed.

```
build ─┐
       ├─→ unit-test → integration-test → system-test → e2e-test
lint  ─┘
```
