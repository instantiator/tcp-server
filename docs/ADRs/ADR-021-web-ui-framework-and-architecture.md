# ADR-021: Web UI Framework and Application Architecture

**Status:** Accepted (2026-07-30)

## Context

The web UI is a new client application. Some choices were decided in planning before this ADR, and are recorded here (not re-evaluated).

**Almost all of the application state is server state.** This is unusual. Much of the state is delivered by SSE[^sse]. There is very little client-side state:

- a theme selection
- open dialog tracking
- filters for some lists

_For now_, a general-purpose client-side data store isn't needed.

[^sse]: Server-Sent Events — a long-lived HTTP connection the server pushes updates down, so the browser sees changes without polling.

## What needs deciding

Two things:

1. **How the browser talks to the API.** The API description is generated from the server's code and changes with it, so a hand-maintained client would drift.
2. **Where state lives.** With almost no client-side state, a conventional data store may be unnecessary weight.

## Options considered

### Pre-decided

| Concern      | Choice            | Notes                                                   |
| ------------ | ----------------- | ------------------------------------------------------- |
| UI library   | React             | This is a large, accessible-component ecosystem         |
| Build system | Vite              | SPA output that can be hosted statically                |
| Routing      | React Router      | Supports deep-links for company/task URLs               |
| Server state | TanStack Query v5 | Manages caching, invalidation and request deduplication |

If any of these choices don't hold up during development we'll open a new ADR to revise the decision.

### API client generation

| Option                                                           | Notes                                                                                                                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`openapi-typescript` types with a hand-written fetch wrapper** | Generates types only. We'll write a runtime layer, but this can be reasonably small. It needs to provide auth, error normalisation, and SSE connections.                 |
| Fully generated client with `openapi-generator`, `orval`, ...    | Generates types and callable methods (and, optionally, React Query hooks). This generates a lot of code, and does not deliver auth and error handling as needed.         |
| Hand-written client, no generation                               | This offers full control, but the spec is generated from NestJS decorators at runtime and changes with every controller edit. Maintaining this by hand is a lot of work. |

## Decision

We'll use **`openapi-typescript` for types, and write a thin 'fetch wrapper'. TanStack Query will be the only cache.**

There will be no separate client-side data store (Redux, Zustand or similar) in the MVP. Server data lives in the query cache; the few client-side concerns use React state and context.

Live events will **invalidate or patch query cache entries** rather than maintaining a parallel view of system state ([ADR-025](ADR-025-browser-event-stream-consumption.md) specifies the mapping). Chat transcripts are the one exception.

Two forward-planning commitments are made now because they are expensive to retrofit: a [single lookup for user-facing strings](#strings-and-theme-tokens), and [theme tokens](#strings-and-theme-tokens) instead of literal values in CSS.

See Detail for [how the generated types stay current](#the-generated-artefact-is-committed-and-checked-for-drift), [what the fetch wrapper does](#the-fetch-wrapper-is-hand-written-and-small), and [why there is no client store](#why-there-is-no-client-store).

## Consequences

- A new generated artefact joins `schemas/schema.json` in the never-edit-by-hand category, with a CI drift check and a regeneration script.
- The drift check needs the spec, which needs a running tcp-server. At CI, either tcp-server is booted, or a copy of `swagger.json` is committed alongside the generated types and diffed instead. This can be decided at implementation.
- Query-key conventions must be settled early. Live events invalidate by key, so an inconsistent key scheme surfaces as events that update some views and not others - leading to a bug that looks like a streaming fault and is not.
- The chat transcript being outside the query cache means it won't survive a dialog unmount. Reopening a chat will reload from `GET /api/agent/:id/history`; that is a real request and the implementation prompt will need to make that clear.
- Persisting preferences (theme, filters) is not covered here. It may be desirable after MVP, server-side or locally.

## Alternatives considered

- **A full client generator with React Query hooks.** Attractive: it would produce the hooks this application would otherwise hand-write. Rejected because the generated hooks would not know about the SSE invalidation contract, the shared 401 policy, or the token source — so each would need wrapping, leaving both a generated and a hand-written layer to maintain.
- **A client-state store alongside the query cache.** Rejected: the application has almost no client state, and the store's main effect would be to create a second, staler copy of server data.
- **Skipping generation and hand-writing typed calls.** Rejected: the spec regenerates on every controller change, so hand-maintenance guarantees the client and server disagree — silently, and in a browser where the failure is a runtime `undefined` rather than a compile error.

## Prompts to update when this is decided

- `002.01.00.prompt - application infrastructure (draft).md`
- `003.02.00.prompt - application shell, routing and header (draft).md`
- `005.01.00.prompt - generated api client (draft).md`

## Detail

### The generated artefact is committed and checked for drift

The API spec comes from `GET /swagger-json` (see: [ADR-014](ADR-014-swagger-endpoints.md)). It is produced at runtime — so it is always correct, and may change. The generated types are committed to the repository (so a developer can typecheck without a running server). A CI step regenerates and diffs them, failing if they are stale.

This mirrors how `schemas/schema.json` and `docs/licenses.md` are already handled: generated, committed, and never edited by hand.

### The fetch wrapper is hand-written, and small

Three things must happen on every request:

- attach the bearer token
- normalise errors into one shape
- and apply the shared 401 policy

These are also needed to read SSE streams, and API-client generators don't support that. A fetch-wrapper built for the project can also be used with an SSE reader, so there is one implementation of each rather than a generated one and a hand-written one that disagree.

### Why there is no client store

Server data lives in the query cache. The handful of genuinely client-side concerns (theme, open dialogs, filter selections) will use React state and context.

For the MVP, client-side data store management tools like Redux, Zustand, or another equivalent, aren't needed. This helps to avoid risks of data quickly becoming stale as events arrive, and simplifies the MVP implementation.

The exception: live chat transcripts, which are append-only, have high-frequency and are never re-fetched. That is held as local component state, outside the cache.

### Strings and theme tokens

These decisions are architectural commitments at MVP:

- **Strings.** Every user-facing string will resolve through a single lookup (`strings.ts`, or a trivial `t('key')` function) rather than being inlined in JSX. There won't be an i18n library, and no locale files in the MVP, but this will simplify the translation work described in phase 03.
- **Theme tokens.** Colour, spacing and border values will resolve through CSS custom properties, not literals, in component CSS. Component CSS files will have meaningful class names and empty rule bodies, to be filled per theme later.

This will reduce the effort required to retrofit these accessibility features later. [ADR-026](ADR-026-web-ui-accessibility-and-component-library.md) describes the theme model.
