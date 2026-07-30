# ADR-028: Frontend Testing Strategy

**Status:** Proposed (2026-07-30)

## Context

The repository has five test tiers — `unit`, `integration`, `e2e`, `api`,
`smoke` — all Jest, each with a `scripts/run-<tier>-tests.sh` launcher, and
[ADR-016](ADR-016-test-infrastructure-orchestration.md) governs how the
container-backed ones are orchestrated. The frontend needs unit and component
testing, and the originating prompt asks for a browser tier driving real
end-to-end flows against Docker Compose and `tcp-stub-llm`.

Two things about ADR-016 matter here. It draws a line between the
testcontainers-driven tiers (`integration`, `e2e`) and the deployed-stack tiers
(`api`, `smoke`), and it states an **instance-agnostic invariant**: the api and
smoke tiers are pure black-box clients of a stack someone else started. A
browser tier is unambiguously on that side of the line — it drives a real
browser against a fully built, deployed application.

The prompt also asks for comprehensive tests on every component and every pure
function. That bar, applied literally across twenty-odd implementation prompts,
is enough work to become the schedule, so this ADR says what it means.

## Options considered

### Test runner

|                                                    | **Vitest**                                                               | Jest                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Transform pipeline                                 | Reuses the app's `vite.config.ts` — one pipeline for dev, build and test | A second, independent pipeline (ts-jest or babel) over the same source |
| JSX, CSS imports, static assets, `import.meta.env` | Handled, because Vite handles them                                       | Each needs configuring and can diverge from what Vite does             |
| Consistency with this repo                         | New runner alongside Jest                                                | Same runner everywhere                                                 |
| API                                                | Jest-compatible (`describe`/`it`/`expect`)                               | —                                                                      |
| CI reporting                                       | JUnit XML, same as the existing tiers                                    | Already wired                                                          |

The decisive point is the transform pipeline. The frontend is a Vite
application; testing it with Jest means maintaining a second compilation of the
same source, with its own answers for JSX, CSS-module imports, asset stubs and
`import.meta.env`. That divergence produces the "passes in tests, breaks in the
browser" class of bug — and the reverse.

[ADR-022](ADR-022-monorepo-workspace-structure.md) makes per-workspace tooling
normal, so this is no longer an all-or-nothing choice for the repository.

### Browser driver

Playwright. No browser tooling exists in the repo today, so there is no
incumbent. It is chosen over Cypress principally for `@axe-core/playwright` and
its multi-browser/WebKit support, both of which serve
[ADR-026](ADR-026-web-ui-accessibility-and-component-library.md)'s audit
requirements directly.

## Decision

**Vitest + Testing Library for the frontend workspace; Jest unchanged everywhere
else; Playwright as a sixth tier following the api/smoke pattern.**

### Vitest in the frontend workspace only

The backend keeps Jest and its five tiers exactly as they are. The frontend
workspace gets Vitest, `@testing-library/react`, `@testing-library/user-event`
and jsdom. Both emit JUnit XML into `test-results/`, so CI reporting stays
uniform and `dorny/test-reporter` needs no special case.

### The browser tier is the sixth tier, and it is black-box

It follows the **api/smoke** shape, not the integration/e2e one: a
`scripts/run-browser-tests.sh` launcher that drives an already-running
deployment started by `scripts/start-deployment.sh` with `tcp-stub-llm`, exactly
as `run-api-tests.sh` does. It provisions nothing itself and honours ADR-016's
instance-agnostic invariant — no reaching into containers, no assumptions about
which stack it is pointed at, base URL passed in.

This also means it reuses the CI job shape that already builds images with
`docker/bake-action` and starts a deployment, rather than adding a new
orchestration pattern.

### What "comprehensive" means

The prompt's bar, made proportionate:

| Tier           | Bar                                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure functions | Every function, success **and** failure paths. Unchanged from the prompt — these are cheap and this is where parsing bugs live                  |
| Components     | Behaviour, not appearance. Query by role and accessible name; assert what a user can do. One axe assertion per component. **No snapshot tests** |
| Browser        | Roughly six journeys covering the MVP end to end — not per-component coverage                                                                   |

**Querying by role and accessible name is the point**, not a stylistic
preference: a component that cannot be queried that way is a component a screen
reader cannot describe. The component tier therefore doubles as continuous
accessibility pressure, which is why snapshots are excluded — they assert
structure, catch nothing about usability, and fail on every intended change.

The six browser journeys: sign in → companies overview; open a company and see
live activity; create a task and watch it progress; chat with a role and receive
a streamed reply; answer a user enquiry; sign out and land back on the landing
page. Each scans its rendered pages with axe.

### Mocking stops at the network boundary

Component tests mock the API client and the stream subscription — not React
Router, not the query cache, not the announcer. Mocking framework internals
produces tests that pass while the application is broken. The stream mock feeds
`WireEvent`s directly, so live-update behaviour is testable without a server.

## Consequences

- Two test runners in one repository. Justified by the transform-pipeline
  argument and made unremarkable by the workspace split, but it is a real cost:
  a contributor must know which applies where, and the two configs will drift in
  small ways.
- A sixth tier means a sixth launcher script, a new `run-all-tests.sh` step, a
  new CI job, and Playwright browser binaries in CI (cached, or the job pays a
  download every run).
- Playwright's browser binaries are a large dev dependency. Contributors who
  never touch the frontend still pay the install unless it is scoped to the
  frontend workspace — which the workspace split makes possible.
- Axe assertions in every component test slow the suite and will surface
  violations in components that "look fine". That is the intent.
- The browser tier depends on `tcp-stub-llm`, which today has **zero CI
  coverage** (ADR-022). Making it the engine of the browser tier gives it
  coverage by use, but a stub-llm regression now breaks the browser tier — worth
  knowing when one fails.
- Excluding snapshots removes the fastest way to add nominal coverage. The bar
  above is deliberately harder to game.
- `run-all-tests.sh` gets longer. It is already the slowest thing in the repo,
  and a browser tier is not fast.

## Alternatives considered

- **Jest for the frontend too.** One runner, one mental model, CI already wired.
  Rejected on the second transform pipeline — the divergence it creates is
  exactly the kind of failure that is expensive to diagnose, and ADR-022 removes
  the consistency argument's force.
- **Cypress.** Mature, excellent debugging. Rejected: weaker multi-browser
  support and a less direct axe integration, both of which matter more here than
  developer ergonomics.
- **Component tests in the browser** (Playwright component testing / Vitest
  browser mode). Higher fidelity than jsdom, notably for focus and live regions —
  which are exactly this application's hard parts. Rejected for the MVP on speed
  and maturity; genuinely worth revisiting if jsdom's focus model proves
  insufficient for ADR-027's requirements.
- **No browser tier; rely on component tests plus the existing api tier.**
  Cheapest. Rejected: nothing else exercises the OIDC redirect, the SSE
  connection, or HTTP/2 multiplexing under real connection limits — the three
  things most likely to fail only in a real browser.

## Prompts to update when this is decided

- `002.02.00.prompt - testing infrastructure (draft).md`
- `009.01.00.prompt - browser test suite for mvp journeys (draft).md`
- The testing section of every feature prompt (`003.*` – `008.*`)
