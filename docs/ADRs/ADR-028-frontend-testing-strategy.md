# ADR-028: Frontend Testing Strategy

**Status:** Accepted (2026-08-03)

## Context

The repository has 5 test tiers — `unit`, `integration`, `e2e`, `api`, `smoke` — all using Jest, each with a `scripts/run-<tier>-tests.sh` launcher. [ADR-016](ADR-016-test-infrastructure-orchestration.md) governs how the container-backed ones are orchestrated.

Two things in ADR-016 matter here:

1. It separates the tiers that **start their own containers** (`integration`, `e2e`) from the tiers that **test an already-running deployment** (`api`, `smoke`).
2. The api and smoke tiers must stay pure black-box clients — they test whatever stack they're pointed at, and never reach inside it.

## What needs deciding

1. **Which test runner** the frontend uses.
2. **How browser tests fit** the existing tier model.
3. **What "comprehensive" means.** The originating prompt asks for comprehensive tests on every component and every pure function. Applied literally across twenty-odd implementation prompts, that bar is enough work to become the schedule.

## Options considered

### Test runner

|                                 | **Vitest**                                                              | Jest                                                      |
| ------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| Transform pipeline[^transform]  | Reuses the app's own Vite config — one pipeline for dev, build and test | A second, separate pipeline over the same source          |
| JSX, CSS imports, static assets | Handled, because Vite already handles them                              | Each needs configuring, and can drift from what Vite does |
| Consistency with this repo      | A new runner alongside Jest                                             | Same runner everywhere                                    |
| Test API                        | Jest-compatible                                                         | —                                                         |
| CI reporting                    | JUnit XML, same as existing tiers                                       | Already wired                                             |

[^transform]: The step that turns source code into something the runtime can execute — compiling TypeScript, JSX, and so on. Two pipelines over the same code can disagree, which is where "passes in tests, breaks in the browser" comes from.

### Browser driver

Playwright. There's no browser tooling in the repo today, so there's no incumbent to weigh against. It's preferred over Cypress mainly for its accessibility-testing integration and its WebKit support — both of which serve [ADR-026](ADR-026-web-ui-accessibility-and-component-library.md) directly.

## Decision

**Vitest and Testing Library for the frontend workspace. Jest stays unchanged everywhere else. Playwright as a sixth tier, following the api/smoke pattern.**

The decisive argument for Vitest is the transform pipeline. The frontend is a Vite application, so testing it with Jest means maintaining a second compilation of the same source, with its own answers for JSX, CSS imports and asset handling. That divergence produces bugs that are expensive to diagnose.

[ADR-022](ADR-022-monorepo-workspace-structure.md) makes per-workspace tooling normal, so this is no longer an all-or-nothing choice for the repository.

- The browser tier is [black-box, like api and smoke](#the-browser-tier-is-black-box) — it drives a deployment someone else started.
- ["Comprehensive" is defined](#what-comprehensive-means), with a proportionate bar per tier.
- [Mocking stops at the network boundary](#mocking-stops-at-the-network-boundary).

## Consequences

- **Two test runners in one repository.** Justified by the transform-pipeline argument, and no longer unusual now that the workspace split ([ADR-022](ADR-022-monorepo-workspace-structure.md)) gives each part of the repo its own tooling — but it's a real cost: a contributor has to know which applies where, and the two configs will drift in small ways.
- A sixth tier means a sixth launcher script, a new step in `run-all-tests.sh`, a new CI job, and Playwright browser binaries in CI — cached, or the job pays a download every run.
- Those binaries are a large dev dependency. Contributors who never touch the frontend still pay the install unless it's scoped to the frontend workspace, which the workspace split makes possible.
- Accessibility assertions in every component test slow the suite, and will surface violations in components that "look fine". That's the intent.
- **The browser tier depends on `tcp-stub-llm`, which today has no CI coverage at all** ([ADR-022](ADR-022-monorepo-workspace-structure.md)). Making it the engine of the browser tier gives it coverage by use — but a stub-llm regression now breaks the browser tier, which is worth knowing when one fails.
- Excluding snapshot tests removes the fastest way to add nominal coverage. The bar is deliberately harder to game.
- `@guidepup/virtual-screen-reader` joins the component tier's dev dependencies, per [ADR-027](ADR-027-screen-reader-strategy.md). jsdom-based, no browser or OS screen reader needed — it doesn't change the tier's shape, only what "comprehensive" requires of announcer-related components.
- `run-all-tests.sh` gets longer. It's already the slowest thing in the repo, and a browser tier isn't fast.

## Alternatives considered

- **Jest for the frontend too.** One runner, one mental model, CI already wired. Rejected on the second transform pipeline — and ADR-022 removes the force of the consistency argument.
- **Cypress.** Mature, with excellent debugging. Rejected: weaker multi-browser support and a less direct accessibility integration, both of which matter more here than developer ergonomics.
- **Component tests in a real browser** (Playwright component testing, or Vitest browser mode). Higher fidelity than a simulated DOM, particularly for focus and live regions — which are exactly this application's hard parts. Rejected for the MVP on speed and maturity; genuinely worth revisiting if the simulated DOM proves insufficient for [ADR-027](ADR-027-screen-reader-strategy.md).
- **No browser tier at all**, relying on component tests plus the existing api tier. Cheapest, and rejected: nothing else exercises the sign-in redirect, the event stream connection, or HTTP/2 behaviour under real connection limits — the three things most likely to fail only in a real browser.

## Prompts to update when this is decided

- `002.02.00.prompt - testing infrastructure (draft).md`
- `phase 04 - web ui quality/001.01.00.prompt - browser test suite for mvp journeys (draft).md`
- The testing section of every feature prompt (`003.*` – `008.*`)

## Detail

### Vitest in the frontend workspace only

The backend keeps Jest and its five tiers exactly as they are. The frontend workspace gets Vitest, `@testing-library/react`, `@testing-library/user-event` and a simulated DOM.

Both emit JUnit XML into `test-results/`, so CI reporting stays uniform and the existing test reporter needs no special case.

### The browser tier is black-box

It follows the **api/smoke** shape, not the integration/e2e one.

A `scripts/run-browser-tests.sh` launcher drives an already-running deployment, started by `scripts/start-deployment.sh` with `tcp-stub-llm` — exactly as `run-api-tests.sh` does. It provisions nothing itself, makes no assumptions about which stack it's pointed at, and takes its base URL as input.

This honours ADR-016's black-box invariant, and it reuses the CI job shape that already builds images and starts a deployment, rather than adding a new orchestration pattern.

### What "comprehensive" means

| Tier           | Bar                                                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure functions | Every function, success **and** failure paths. Unchanged from the prompt — these are cheap, and it's where parsing bugs live                              |
| Components     | Behaviour, not appearance. Query by role and accessible name; assert what a user can do. One accessibility assertion per component. **No snapshot tests** |
| Browser        | Roughly six journeys covering the MVP end to end — not per-component coverage                                                                             |

**Querying by role and accessible name is the point**, not a stylistic preference: a component that can't be queried that way is a component a screen reader can't describe. The component tier therefore also works as an ongoing accessibility check, every time the tests run.

**Any component that announces to screen readers carries a heavier bar.** [ADR-027](ADR-027-screen-reader-strategy.md) makes the announcer's coalescing, throttling and "never word by word" rules an automated gate in this same tier, using `@guidepup/virtual-screen-reader` alongside plain live-region assertions. "Comprehensive" for those components means that test exists, not just the usual behavioural one — see ADR-027's Detail section for the exact mechanism.

That's also why snapshots are excluded — they assert structure, catch nothing about usability, and fail on every intended change.

The six browser journeys:

1. Sign in, and reach the companies overview
2. Open a company and see live activity
3. Create a task and watch it progress
4. Chat with a role and receive a streamed reply
5. Answer a user enquiry
6. Sign out, and land back on the landing page

Each scans its rendered pages for accessibility violations.

### Mocking stops at the network boundary

Component tests mock the API client and the stream subscription. They do **not** mock React Router, the query cache, or the announcer.

Mocking framework internals produces tests that pass while the application is broken.

The stream mock feeds events directly, so live-update behaviour is testable without a server.
