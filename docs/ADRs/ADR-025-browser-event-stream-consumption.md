# ADR-025: Browser Event Stream Consumption

**Status:** Proposed (2026-07-30)

> **This supersedes the "use a native `EventSource`" recommendation in
> `docs/prompts/phase 02 - web ui/001.01.00.prompt - mvp planning.md`.** That
> recommendation cannot be implemented — see below.

## Context

[ADR-015](ADR-015-agent-completion-sse.md) chose SSE over WebSockets and
long-polling for the server side, and three streams exist today:
`GET /api/agent/:id/events`, `GET /api/company/:id/events`, and
`GET /api/task/:id/events`. That decision is not re-opened. This ADR is about the
browser end of the same pipe.

**Native `EventSource` cannot be used.** All three endpoints carry a class-level
`@UseGuards(JwtAuthGuard)`, and the `EventSource` constructor accepts only
`(url, { withCredentials })` — there is no way to attach an `Authorization`
header. The planning prompt's recommendation predates this discovery.

Three further facts shape the design:

1. **One event union, not three.** Every stream carries `WireEvent` —
   `{ type: 'audit', event: AuditWireEvent } | StreamDelta` — discriminated at
   runtime on `payload.entity`. There are no separate agent/company/task event
   types to model.
2. **A working reader already exists.** `apps/tcp-cli/src/lib/core/sse.ts` (30
   lines) and `sse-reader.ts` (43 lines) read these exact endpoints and are
   unit-tested. `parseWireEvents` imports only a _type_ from `@tcp/shared`, so it
   is portable verbatim.
3. **Connection count is a real constraint.** Agent transcripts and
   `StreamDelta`s reach only the agent channel, so every open chat and every
   assignment panel needs its own connection. A task dialog with four assignments
   plus the live activity view is already five.

## Options considered

### Transport

| Option                          | Trade-off                                                                                                                                                                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **fetch + `ReadableStream`**    | Sets headers freely. The 73 lines already in `tcp-cli` do this; no reconnection logic yet                                                                                                                                                                                  |
| `@microsoft/fetch-event-source` | Purpose-built for exactly this problem, and supplies retry, `Last-Event-ID`, visibility-aware reconnect and lifecycle callbacks. **v2.0.1, published 2021-04-25** — over five years old, 20 commits total, 51 open issues, 22 open PRs. MIT, not archived, simply finished |
| `eventsource-parser`            | Actively maintained (3.1.0, MIT, 2026-05), widely used for LLM streaming. Parser only — does not close the reconnection gap either                                                                                                                                         |
| Token in query string           | Makes native `EventSource` work. Puts a bearer credential into URLs, access logs and browser history. Rejected                                                                                                                                                             |
| Cookie auth on stream routes    | Makes native `EventSource` work via `withCredentials`. Requires a second auth mechanism server-side, contradicting [ADR-024](ADR-024-browser-oidc-client-and-token-handling.md)'s in-memory tokens. Rejected                                                               |

## Decision

**fetch + `ReadableStream`, extending the reader `tcp-cli` already has, promoted
into `@tcp/shared/client`.**

`parseWireEvents` and `wire-parse.ts` move to the client export
([ADR-022](ADR-022-monorepo-workspace-structure.md)) unchanged. Both clients then
parse the stream through one implementation, so the CLI and the browser cannot
drift on what a given event means.

### Why not the Microsoft library, given it solves the harder half

It genuinely does supply what the existing 73 lines lack — backoff, page
visibility handling, `Last-Event-ID`, a proper lifecycle. That is the honest case
for it, and it is not weak.

It is rejected because the remaining gap is smaller than it looks and the
dependency is larger than it looks. The gap is reconnection alone, perhaps 40–60
lines, and two things already shrink it: the server **primes** company and task
streams with current state on subscribe, and `AgentController.replayTerminal`
synthesises a terminal event for late subscribers — so catch-up-after-reconnect
is substantially solved server-side already. `navigator.onLine` and
`visibilitychange` come free from the platform. Meanwhile the package has not
shipped in over five years, and it would sit directly under the application's
flagship feature. Adopting it would also leave two parsers in the repository —
its own and the CLI's — for the same wire format.

The backoff policy and the subscription manager have to be specified by this ADR
regardless of who owns the socket, so the library would not remove that work
either.

### HTTP/2 is required, in development as well as production

Browsers cap concurrent connections per origin at six under HTTP/1.1. As
established above, five connections is an ordinary working state. HTTP/2
multiplexes them over one connection and removes the ceiling.

This must hold in development too. `vite dev` serves HTTP/1.1 by default, and
the failure mode is the worst kind: requests simply hang, with no error, looking
exactly like a backend fault. The dev server and preview server need HTTP/2
enabled, not only the production nginx image
([ADR-029](ADR-029-spa-hosting-and-runtime-configuration.md)).

### A refcounted subscription manager owns every connection

Several components can want the same stream — two panels showing the same agent,
a list and a dialog both watching a task. One manager keyed by stream URL holds
one connection per key with a subscriber count, opening on the first subscriber
and closing after the last. It also enforces a hard connection cap, so the
failure mode under an unexpected fan-out is a logged, bounded refusal rather than
silent browser-level queuing.

### Reconnection: bounded exponential backoff, primed recovery

On drop: reconnect with exponential backoff and jitter, capped, and reset on a
successful read. Suspend retries while `navigator.onLine` is false or the
document is hidden, and retry immediately when either flips back. Recovery
state comes from the server's priming rather than from client-side
`Last-Event-ID` bookkeeping — the endpoints already prime, so a reconnected
company or task stream re-renders correctly on its own.

Each connect attempt fetches a fresh token (ADR-024), so renewal happens as part
of reconnection.

### Events map to cache invalidation, except transcripts

`WireEvent`s carrying an entity summary (`state_change` with a
`TaskChangeSummary` or `AssignmentChangeSummary`) **patch** the corresponding
TanStack Query cache entry — the payload is the same shape a list row renders,
so no refetch is needed. Events without a usable summary invalidate their query
key instead.

`StreamDelta`s do not touch the cache. They are high-frequency, append-only, and
belong to a specific open transcript — they go to local component state
([ADR-021](ADR-021-web-ui-framework-and-architecture.md)).

## Consequences

- `parseWireEvents` and `wire-parse.ts` move from `tcp-cli` into
  `@tcp/shared/client`, and the CLI imports them from there. A small change to a
  working client, done for real reuse rather than tidiness.
- HTTP/2 becomes a hard requirement of the dev environment, not just the
  deployment. It needs to be verified early — the symptom is indistinguishable
  from a server problem.
- The subscription manager is infrastructure that must exist before the second
  streaming surface, not after. Built late, every consumer needs rewriting.
- Reconnection correctness depends on the server continuing to prime the company
  and task streams. That coupling is now load-bearing for the client and should
  not be removed without revisiting this ADR.
- **A minimised chat dialog's stream is a decision, not a detail.** Four
  minimised chats holding connections plus a task dialog plus the live view is
  the ceiling again. Whether minimised chats detach and re-prime on restore is
  specified by the chat dialog prompt.
- Live-region announcements are driven from the same events; throttling and
  coalescing are [ADR-027](ADR-027-screen-reader-strategy.md)'s, not this ADR's.
- An open stream outlives access-token expiry (ADR-024). Reconnection re-auths;
  a continuously-open stream does not.

## Alternatives considered

- **`@microsoft/fetch-event-source`.** Argued above. The strongest alternative,
  rejected on maintenance age and on duplicating a parser the repo already has.
- **`eventsource-parser`.** Maintained and well-used, but parser-only — it
  replaces the 30 lines that already work and leaves the 40–60 lines that do not
  exist. Wrong half of the problem.
- **Token in the query string.** The only route to using native `EventSource`
  without server changes. Rejected: bearer tokens in URLs are logged by proxies
  and retained in history.
- **Cookie authentication for stream routes.** Also enables native
  `EventSource`, and requires a parallel server-side auth mechanism plus a
  session, contradicting ADR-024. Rejected.
- **Polling instead of streaming.** Would sidestep the connection ceiling
  entirely. Rejected: live observation is the capability the web client exists to
  provide ([ADR-020](ADR-020-web-ui-mvp-scope.md)).
- **A single multiplexed stream endpoint.** One connection carrying every entity
  the user is watching would remove the ceiling without HTTP/2. A substantial
  server-side change to ADR-015's model; the natural answer if HTTP/2 proves
  unavailable in some deployment, and not needed otherwise.

## Prompts to update when this is decided

- `002.03.00.prompt - static hosting and runtime configuration (draft).md`
- `005.02.00.prompt - sse client and event handling (draft).md`
- `007.01.00.prompt - company live activity view (draft).md`
- `008.01.00.prompt - dialog framework and event transcript components (draft).md`
- `008.02.00.prompt - chat dialog (draft).md`
- `008.03.00.prompt - task dialog (draft).md`
- `008.04.00.prompt - user response dialog (draft).md`
