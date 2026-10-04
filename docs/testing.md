# Testing

## Strategy

The project uses seven test tiers that run in increasing order of scope and
infrastructure requirement. CI runs them in this order — a failure at any tier
gates the next:

```text
unit → integration → api + smoke + e2e + browser + backup
```

| Tier        | What it proves                                                               | Infrastructure                            |
| ----------- | ---------------------------------------------------------------------------- | ----------------------------------------- |
| Unit        | Individual classes and functions behave correctly                            | None — SQLite in-memory                   |
| Integration | The app can connect to and use each backing service                          | Docker (postgres, redis, minio, stub-llm) |
| E2E         | HTTP API workflows produce the right responses end-to-end                    | Docker (postgres, redis, minio)           |
| API         | Requests and responses through the tcp-server API with a real JWT            | A running stack, with Zitadel             |
| Smoke       | Every service in a deployed stack is up, healthy, and serving its Swagger UI | A running stack                           |
| Browser     | The web app works in a real browser, and is free of axe violations           | Something serving the web app             |
| Backup      | A backup restores onto a fresh stack with nothing lost                       | Docker; starts its own stack              |

The api and smoke tiers run against the same stack in CI's `api-test` job,
which is why they are often referred to together.

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
HTTP requests directly to the tcp-server API (using real JWTs) and assert on
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

### Two runners

The backend, `libs/tcp-shared` and `scripts/setup-wizard` use **Jest**. The
frontend workspace (`apps/frontend/tcp-frontend`) uses **Vitest** for its unit
and component tests, and **Playwright** for the browser tier
([ADR-028](ADRs/ADR-028-frontend-testing-strategy.md)).

The split exists because the frontend is a Vite application: testing it with
Jest would mean a second compilation of the same source, with its own answers
for JSX, CSS imports and asset handling — and "passes in tests, breaks in the
browser" is what that divergence produces. The rule is simply **which workspace
the file is in**; nothing else changes, since Vitest's test API is
Jest-compatible.

All three emit JUnit XML into `test-results/`, so CI reporting is uniform.

### Accessibility is enforced by the tests

Accessibility is checked at three points
([ADR-026](ADRs/ADR-026-web-ui-accessibility-and-component-library.md)), two of
them automated here:

- **Edit time** — `eslint-plugin-jsx-a11y`, as a lint error.
- **Component tests** — every component test calls `expectNoA11yViolations` from
  `src/test-support/axe.ts`. Contrast is disabled there, because jsdom has no
  layout engine to measure it with.
- **Browser tests** — every journey scans its rendered pages with
  `@axe-core/playwright`, which _can_ measure contrast.

Component tests also query by role and accessible name rather than by test id
wherever possible. That is the accessibility check, not a style preference: a
control that cannot be found that way is one a screen reader cannot describe.

**Announcements have their own gate.** `@guidepup/virtual-screen-reader`
simulates a screen reader against jsdom and reports what would be spoken, in
order — so the coalescing and "never word by word" rules from
[ADR-027](ADRs/ADR-027-screen-reader-strategy.md) fail the build when they
regress. `src/test-support/screen-reader.test.tsx` is the worked example, and
[ADR-027's 002.02 amendment](ADRs/ADR-027-screen-reader-strategy.md#amendment-as-implemented-00202)
records the three API details its documentation gets wrong.

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

This runs **both** runners: the backend's Jest suites and the frontend's Vitest
unit and component tests. To run only the frontend's, and to keep it watching:

```bash
npm test --workspace apps/frontend/tcp-frontend       # once
cd apps/frontend/tcp-frontend && npx vitest           # watch
```

### Integration tests

```bash
./scripts/run-integration-tests.sh
./scripts/run-integration-tests.sh -- --testNamePattern="redis"
```

Jest's global setup starts postgres, redis, minio, and the stub-llm service via
testcontainers (random host ports) and tears them down after the run. Requires
Docker. See [scripts/run-integration-tests.sh](../scripts/run-integration-tests.sh).

### API & smoke tests

Both suites require a running TCP stack with Zitadel. Start one first with
`start-deployment.sh`, then run either or both test scripts against it. In CI
both run against the same stack in the `api-test` job.

`.env.testing` sets `EXPOSE_PORT_API=3001` (so a test stack can coexist with a
dev stack on 3000), and the smoke tier reaches the MCP servers on their host
ports — so start with `--dev-ports` and target port 3001:

```bash
# Start stack (reads Zitadel credentials from env file; writes generated
# client creds to .env.testing.local). --dev-ports publishes the MCP ports.
./scripts/start-deployment.sh --project tcp-api --env-file .env.testing --dev-ports

# Run API tests (TEST_CLIENT_* read from .env.testing.local)
./scripts/run-api-tests.sh --base-url http://localhost:3001 --env-file .env.testing
./scripts/run-api-tests.sh --base-url http://localhost:3001 --env-file .env.testing -- --testNamePattern="company"

# Run smoke tests against the same stack
./scripts/run-smoke-tests.sh --base-url http://localhost:3001

# Tear down
docker compose -p tcp-api --profile auth down -v
```

The scripts default to `http://localhost:3000`; pass `--base-url` to target a
different port (like the 3001 test stack above) or a remote deployment without
Docker:

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

### Backup tests

```bash
./scripts/run-backup-tests.sh --project tcp-backup --env-file .env.testing
```

Starts its own stack, seeds a company and an object, backs up, destroys the
stack with `down -v`, restores and compares row counts and objects. It uses
`.env.testing`'s ports, so no other fixed-port stack can run at the same time.
`run-all-tests.sh` runs it last, after tearing its own deployment down. See
[backup-and-restore.md](backup-and-restore.md).

### Browser tests

Like the api and smoke tiers, this one is a black-box client: it drives
whatever is serving at `--base-url` and provisions nothing
([ADR-016](ADRs/ADR-016-test-infrastructure-orchestration.md)).

**What needs to be running first:** a deployment. Its `tcp-web` service serves
the app, and there is no `webServer` fallback in `playwright.config.ts` — one
that started `vite preview` would also serve HTTP/1.1, quietly hiding the
protocol regression `hosting.spec.ts` exists to catch.

```bash
./scripts/start-deployment.sh --project tcp-dev --env-file .env.dev
./scripts/run-browser-tests.sh
./scripts/run-browser-tests.sh --base-url https://localhost:5174  # the testing stack
./scripts/run-browser-tests.sh -- --headed --grep "heading"
```

`hosting.spec.ts` covers what nginx has to get right
([ADR-029](ADRs/ADR-029-spa-hosting-and-runtime-configuration.md)): HTTP/2 is
actually negotiated (asserted from the browser's own `nextHopProtocol`, not
inferred from the config file), eight simultaneous requests share one
connection rather than hitting the HTTP/1.1 six-connection ceiling, `config.js`
is `no-store` while hashed assets are `immutable`, a deep link survives a cold
load, and `/api` reaches tcp-server on the same origin.

Chromium is the only browser configured; Firefox and WebKit are commented out
in `playwright.config.ts` for a later prompt to enable. Safari and Firefox are
covered per release by ADR-026's manual matrix regardless.

**Browser binaries are not installed by `npm ci`** — they are ~180 MB, and a
contributor who never touches the frontend should not pay for them. The script
installs Chromium on first use; CI caches it keyed on the Playwright version.
See [scripts/run-browser-tests.sh](../scripts/run-browser-tests.sh).

### Signing in

The app keeps no token anywhere Playwright's `storageState` can capture —
tokens live only in `InMemoryWebStorage`
([ADR-024](ADRs/ADR-024-browser-oidc-client-and-token-handling.md)).
`test/browser/auth.setup.ts` is its own Playwright project, runs first, and
signs in once through the real Zitadel login form. What `storageState` saves
is **Zitadel's own session cookie**, not an application token. With that
cookie present, a spec that lands on a guarded route is silently redirected to
the provider, recognised without a prompt, and sent back with a fresh
in-memory token — so every spec signs in for real, and only the setup file
ever sees the login form.

The `chromium` project is **signed out by default**; a spec opts in with
`test.use({ storageState: AUTH_STATE_PATH })` (`test/browser/auth-state.ts`).
That is deliberate — `app-shell.spec.ts` proves a guarded route redirects and
that `?devSession=` cannot sign anyone in, and both would pass trivially if
every spec arrived already signed in.

`scripts/run-browser-tests.sh` resolves `TEST_USERNAME`/`TEST_PASSWORD` the
same way it resolves the machine credentials. When they are absent, the setup
project and every spec that needs a session skip with a stated reason rather
than failing, so a contributor with no deployment can still run the rest of
the tier.

Because every signed-in page signs in afresh, a spec opens one with
`gotoSignedIn(page, path)` (`test/browser/signed-in.ts`), never a bare
`page.goto`. It waits for the header's Account button, with a 15 s budget of
its own, so a slow sign-in doesn't use up the 5 s the next assertion gets. It
also logs how long sign-in took (`[sign-in] <path> <ms>`) and records it as
a `sign-in` annotation.

Signed-in specs run in their own Playwright project, `chromium-signed-in`, at
half the usual workers, so parallel sign-ins don't overload the identity
provider. A new signed-in spec must be added to `SIGNED_IN_SPECS` in
`playwright.config.ts`, or it runs at full parallelism.

To run the signed-in specs locally, start a deployment that provisions a test
user — `start-deployment.sh` does, against `.env.dev` — then run the tier as
above; `run-browser-tests.sh` picks the credentials up automatically.

## Test infrastructure

The **integration** and **e2e** tiers provision their backing services with
[testcontainers](https://node.testcontainers.org/), driven from Jest
`globalSetup`/`globalTeardown` (`apps/backend/test/integration/global-*.ts`,
`apps/backend/test/e2e/global-*.ts`). The shared helper `apps/backend/test/support/testcontainers-env.ts`
starts the services from the project's own `docker-compose.yml`, so there is one
source of truth for how they are configured.

A small test-only overlay, `apps/backend/test/support/docker-compose.dynamic-ports.yml`,
replaces the fixed host-port bindings with random ones (via the Compose Spec's
`!override` tag). This is what lets a test run coexist with a dev stack — and is
why the runner scripts no longer pause a dev container or probe for
already-running infrastructure.

Required env vars are read via `apps/backend/test/support/require-env.ts`, which throws if a
value is missing rather than letting a spec silently skip. If a container fails
to start, the helper writes each service's logs to
`test-results/<tier>-compose-logs/` (uploaded as a CI artifact on failure) and
raises an error that distinguishes a crash-looping container from a
port-binding failure.

The **api** and **smoke** tiers are unchanged: they use `docker-compose.yml` +
`start-deployment.sh` (including the Zitadel bootstrap) and act purely as
clients against an already-running instance.

## Test file locations

All paths are relative to the repository root. The unit tier is configured in
the `jest` block of `apps/backend/package.json`; its `roots` reach out to
`libs/tcp-shared` and `scripts/setup-wizard`, which sit outside that workspace.

| Suite            | Pattern                                                      | Config                                               |
| ---------------- | ------------------------------------------------------------ | ---------------------------------------------------- |
| Unit             | `apps/backend/apps/**/src/**/*.spec.ts`, `libs/**/*.spec.ts` | `apps/backend/package.json` (`jest` block)           |
| E2E              | `apps/backend/test/e2e/**/*.e2e-spec.ts`                     | `apps/backend/test/jest-e2e.json`                    |
| Integration      | `apps/backend/test/integration/**/*.integration-spec.ts`     | `apps/backend/test/jest-integration.json`            |
| Smoke            | `apps/backend/test/smoke/**/*.spec.ts`                       | `apps/backend/test/jest-smoke.json`                  |
| API              | `apps/backend/test/api/**/*.spec.ts`                         | `apps/backend/test/jest-api.json`                    |
| Unit + component | `apps/frontend/tcp-frontend/src/**/*.test.{ts,tsx}`          | `apps/frontend/tcp-frontend/vite.config.ts` (`test`) |
| Browser          | `apps/frontend/tcp-frontend/test/browser/**/*.spec.ts`       | `apps/frontend/tcp-frontend/playwright.config.ts`    |

Frontend tests are **colocated** with the code they cover (`.test.tsx` next to
the component), unlike the backend's container-backed tiers, which live under
`apps/backend/test/`. The browser tier is the exception, sitting in its own
directory because it belongs to no single component.

## CI pipeline

Tests run in the same order in CI (see `.github/workflows/ci.yml`). Build and
lint run in parallel first; each subsequent tier only runs if the previous
passed.

```text
verify (build + lint + typecheck) → unit-test → integration-test ─┬─→ api-test (includes smoke + browser)
                                                                   ├─→ e2e-test
                                                                   └─→ backup-test
```

The browser tier shares the `api-test` job rather than having one of its own:
from 002.03 it drives the deployment's `tcp-web` service, and `api-test` is the
job that starts a deployment. A separate job would pay for a second full stack
to reach the same state.

`backup-test` is its own job, rather than part of `api-test`, because it
destroys and recreates its stack. Running in parallel means the extra stack
start doesn't lengthen the run.

`unit-test` publishes two reports — `unit.xml` from Jest and `frontend.xml`
from Vitest — because one job runs both runners.
