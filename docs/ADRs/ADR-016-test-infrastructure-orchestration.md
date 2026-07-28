# ADR-016: Test Infrastructure Orchestration

**Status:** Accepted (2026-07-08)

## Context

The five test tiers (`unit`, `integration`, `e2e`, `api`, `smoke`) were
orchestrated entirely by shell scripts wrapping the root `docker-compose.yml`.
For the `integration` and `e2e` tiers this had grown fragile:

- `run-integration-tests.sh` hardcoded and paused a specific dev container name
  (`tcp-dev-tcp-agent-1`) to stop a competing BullMQ worker from stealing queue
  jobs off the same shared Redis.
- Both `run-integration-tests.sh` and `run-e2e-tests.sh` carried two divergent
  teardown paths depending on whether a dev stack was already running.
- All services bound fixed host ports, so no two stacks could run at once
  (`run-all-tests.sh` pre-flight-checked for stray `tcp-*` containers).
- Running the e2e suite directly (bypassing the wrapper) **hung** rather than
  failing, because BullMQ enqueue calls block forever against an unreachable
  Redis.
- Integration specs silently skipped when env vars were absent, risking false
  passes; `--forceExit` was required to make Jest exit.

No ADR previously covered test-runner tooling (ADR-009 is deployment-scoped;
ADR-004 mentions e2e's Postgres dependency only in passing). The question
raised: should we move dependency provisioning into the test code itself using
[testcontainers](https://node.testcontainers.org/)?

## Decision

Adopt testcontainers' `DockerComposeEnvironment` for the **integration** and
**e2e** tiers only, driven from Jest `globalSetup`/`globalTeardown`, pointed at
the existing `docker-compose.yml` (unmodified). Leave `api`, `smoke`, and
`unit` exactly as they are.

Key points:

- **A test-only overlay** (`test/support/docker-compose.dynamic-ports.yml`)
  uses the Compose Spec's `!override` tag to swap the fixed host-port bindings
  for random ones. This is what makes the integration/e2e stacks collision-free
  and removes the need for the dev-container pause hack and the port pre-flight
  check (for those tiers). `docker-compose.yml` itself is never modified, so it
  stays usable for deployments.
- **The runner scripts shrink to thin wrappers** around
  `npm run test:integration` / `npm run test:e2e`. All infra lifecycle now lives
  in Jest's own global setup/teardown, so a bare `jest --config ...` run
  provisions infra too — the "hangs if run directly" footgun is gone.
- **Diagnostics are a first-class requirement**: on a failed startup the shared
  helper (`test/support/testcontainers-env.ts`) persists each service's logs to
  `test-results/<tier>-compose-logs/` (uploaded as a CI artifact) and raises an
  error that distinguishes a crash-looping container from a port-binding
  failure, rather than an opaque timeout.
- **Required env vars fail loudly** via `test/support/require-env.ts` instead of
  the previous silent-skip guards.

### Why not the `api`/`smoke` tiers

The api and smoke tiers verify the _fully built, deployed_ multi-container stack,
including a real Keycloak realm bootstrapped by ~80 lines of idempotent
`kcadm.sh`. Moving them to testcontainers would relocate that bootstrap logic
into TypeScript without simplifying it, and would lose a real CI optimisation:
the `api-test` job builds all five app images once with
`docker/build-push-action` + `cache-from/cache-to: type=gha` (BuildKit's GitHub
Actions layer cache), then starts them via `start-deployment.sh` **without**
`--rebuild`. testcontainers-node's compose build has no equivalent cache wiring,
so every CI run would rebuild all five images from scratch.

### api/smoke instance-agnostic invariant

The api and smoke tiers are, and must remain, pure black-box clients: they run
against _any_ already-running instance via `--base-url` (local, CI-deployed, or
remote) and never start, stop, or manage that instance's lifecycle. This
migration must not blur that line.

### Redis fail-fast (root-cause fix)

The e2e "hang" was rooted in production code: neither the agent-jobs `Queue`
(tcp-server) nor the `Worker` (tcp-agent) bounded its Redis connection, so an
unreachable Redis blocked indefinitely. Services now probe reachability at
startup via `assertRedisReachable` (`@tcp/shared`) and refuse to start with a
clear error, and both `main.ts` files call `app.enableShutdownHooks()` so the
existing `onModuleDestroy` cleanup actually runs on `SIGTERM`. **Scope:
startup-time reachability only.** Mid-run Redis loss (a connection that drops
after a healthy start) is a separate circuit-breaker/degraded-mode concern,
deliberately out of scope here.

## Consequences

- Integration/e2e runs are isolated and can coexist with a dev stack; the
  container-name pause hack, the reuse fast-path, and the two-branch teardown
  are gone.
- Local iteration no longer reuses an already-running dev stack — each run pays
  full container-startup cost (a few seconds, plus stub-llm's build on a cold
  cache). This was an accepted trade for isolation; testcontainers' reuse mode
  is a possible future enhancement.
- testcontainers drives the `docker compose` CLI, whose behaviour is
  version-sensitive; CI runs a `docker compose version` diagnostic to catch
  drift. `ubuntu-latest` runners need no Docker-in-Docker setup.
- `--forceExit` was removed from `test:integration`; the tier exits cleanly on
  its own.

## Alternatives considered

- **Full adoption (all tiers, including api/smoke).** Rejected: no complexity
  reduction for api/smoke, loses the CI image-build cache, and risks the
  instance-agnostic invariant.
- **Leave everything as shell scripts.** Rejected: does not address the
  documented fragility (dev-container coupling, dual teardown paths, port
  collisions, the e2e hang, silent skips) that motivated the review.
