# ADR-021: Web UI Framework and Application Architecture

**Status:** Proposed (2026-07-30)

## Context

The web UI is a new client application. Several of its foundational choices were
settled in planning before this ADR and are recorded here as ratified rather
than re-evaluated; the rest are genuinely open and are decided below.

The application's shape is unusual in one respect that drives most of what
follows: **almost all of its state is server state**, and much of that arrives
over SSE rather than being fetched. There is very little client-side state — a
theme selection, which dialogs are open, a task status filter. An architecture
that reaches for a general-purpose client store would be solving a problem this
application does not have.

## Options considered

### Pre-decided (ratified, not re-opened)

| Concern      | Choice            | Why it was settled                                                          |
| ------------ | ----------------- | --------------------------------------------------------------------------- |
| UI library   | React             | Stated requirement; the largest accessible-component ecosystem              |
| Build        | Vite              | Stated requirement; SPA output that hosts statically                        |
| Routing      | React Router      | Agreed during planning; deep-linkable company/task URLs are a requirement   |
| Server state | TanStack Query v5 | Stated requirement; caching, invalidation and request dedup without a store |

These are not re-litigated here. If any becomes painful, that is a new ADR.

### API client generation — the open question

| Option                                                        | Trade-off                                                                                                                                                                               |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`openapi-typescript` types + a hand-written fetch wrapper** | Generates _types only_. The runtime layer is ours: ~100 lines, readable, and it is where auth, error normalisation and SSE plumbing already need to live                                |
| Full client generator (`openapi-generator`, `orval`, …)       | Generates types _and_ callable methods, plus optionally React Query hooks. Far more generated code to review, and the generator's opinions about auth and errors fight the ones we need |
| Hand-written client, no generation                            | Total control, zero tooling. Rejected: the spec is generated from NestJS decorators at runtime and changes with every controller edit — hand-maintenance guarantees drift               |

## Decision

**`openapi-typescript` for types, a thin hand-written fetch wrapper for
behaviour, and TanStack Query as the only cache.**

### The generated artefact is committed and drift-checked

The spec comes from `GET /swagger-json` ([ADR-014](ADR-014-swagger-endpoints.md)),
which is produced at runtime from TypeScript metadata — so it is always correct
and always moving. The generated types are committed to the repository (a
contributor can typecheck without a running server) and a CI step regenerates
and diffs them, failing if they are stale. This mirrors how `schemas/schema.json`
and `docs/licenses.md` are already handled: generated, committed, and never
edited by hand.

### The fetch wrapper is ours, and it is small

Three things must happen on every request — attach the bearer token, normalise
errors into one shape, and apply the shared 401 policy. All three are also
needed by the SSE reader, which no API-client generator will produce. Owning
~100 lines of fetch wrapper keeps one implementation of each rather than a
generated one and a hand-written one that disagree.

### TanStack Query is the only cache; there is no client store

Server data lives in the query cache. The handful of genuinely client-side
concerns — theme, open dialogs, filter selections — use React state and context.
No Redux, Zustand, or equivalent. This is not minimalism for its own sake: a
second store invites the same server data to be copied into it, and the copy
then goes stale exactly when a live event arrives.

The SSE layer's job is therefore to **invalidate or patch query cache entries**,
not to maintain a parallel view of the world
([ADR-025](ADR-025-browser-event-stream-consumption.md) specifies the mapping).
The one exception is a live chat transcript, which is append-only, high-frequency
and never re-fetched — that is local component state, deliberately outside the
cache.

### Two seams are architectural commitments, not conventions

- **Strings.** Every user-facing string resolves through a single lookup
  (`strings.ts`, or a trivial `t('key')` passthrough) rather than being inlined
  in JSX. No i18n library and no locale files in the MVP — this exists so the
  phase 03 translation work replaces one module instead of rewriting every
  component.
- **Theme tokens.** Colour, spacing and border values resolve through CSS custom
  properties, never literals in component CSS. Component CSS files ship with
  meaningful class names and empty rule bodies, to be filled per theme later.

Both cost nothing now and are prohibitively expensive to retrofit. See
[ADR-026](ADR-026-web-ui-accessibility-and-component-library.md) for the theme
model itself.

## Consequences

- A new generated artefact joins `schemas/schema.json` in the never-edit-by-hand
  category, with a CI drift check and a regeneration script.
- The drift check needs the spec, which needs a running tcp-server. Either CI
  boots one for that step or a copy of `swagger.json` is committed alongside the
  generated types and diffed instead — the implementing prompt decides.
- Query-key conventions must be settled early. Live events invalidate by key,
  so an inconsistent key scheme surfaces as events that update some views and
  not others — a bug that looks like a streaming fault and is not.
- The chat transcript being outside the query cache means it does not survive
  a dialog unmount. Reopening a chat re-primes from
  `GET /api/agent/:id/history`; that is a real request and the prompt should
  say so rather than leaving it to be discovered.
- Ratifying four choices without evaluation is deliberate. Should one of them
  prove wrong, the replacement gets its own ADR rather than an amendment here.

## Alternatives considered

- **A full client generator with React Query hooks.** Attractive: it would
  produce the hooks this application would otherwise hand-write. Rejected
  because the generated hooks would not know about the SSE invalidation
  contract, the shared 401 policy, or the token source — so each would need
  wrapping, leaving both a generated and a hand-written layer to maintain.
- **A client-state store alongside the query cache.** Rejected above: the
  application has almost no client state, and the store's main effect would be
  to create a second, staler copy of server data.
- **Skipping generation and hand-writing typed calls.** Rejected: the spec
  regenerates on every controller change, so hand-maintenance guarantees the
  client and server disagree — silently, and in a browser where the failure is
  a runtime `undefined` rather than a compile error.

## Prompts to update when this is decided

- `002.01.00.prompt - application infrastructure (draft).md`
- `003.02.00.prompt - application shell, routing and header (draft).md`
- `005.01.00.prompt - generated api client (draft).md`
