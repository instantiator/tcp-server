# ADR-025: Browser Event Stream Consumption

**Status:** Accepted (2026-08-03; amended — see [008.02](#amendment-as-implemented-00802) and [002.02 (phase 03)](#amendment-as-implemented-p03-002-02) at the end)

> [!NOTE]
> **This supersedes the "use a native `EventSource`" recommendation in `docs/prompts/phase 02 - web ui/001.01.00.prompt - mvp planning.md`.** That recommendation cannot be implemented — see below.

## Context

[ADR-015](ADR-015-agent-completion-sse.md) chose SSE[^sse] for the server side, and three streams exist today:

- `GET /api/agent/:id/events`
- `GET /api/company/:id/events`
- `GET /api/task/:id/events`

That decision isn't re-opened. This ADR covers the browser end of the same pipe.

[^sse]: Server-Sent Events — a long-lived HTTP connection the server pushes updates down, so the browser sees changes without polling.

## What needs deciding

**The obvious approach doesn't work.** Browsers have a built-in SSE client called `EventSource`, but it can only be given a URL — there is no way to attach an `Authorization` header. All three streams require one. So `EventSource` is unusable here, and the planning prompt's recommendation predates that discovery.

1. **A working reader already exists.** `apps/backend/apps/tcp-cli/src/lib/core/sse.ts` (30 lines) and `sse-reader.ts` (43 lines) read these exact endpoints and are unit-tested. What they lack is reconnection.
2. **Connection count is a real limit.** Agent transcripts only ever reach the agent stream, so every open chat and every assignment panel needs its own connection. A task dialog with four assignments plus the live activity view is already five — and browsers cap concurrent connections at six per address under HTTP/1.1.

## Options considered

| Option                            | Notes                                                                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **fetch + `ReadableStream`**      | Can set headers freely. The 73 lines already in `tcp-cli` do exactly this. Reconnection would need adding                                                      |
| `@microsoft/fetch-event-source`   | Purpose-built, and supplies the reconnection we lack. **v2.0.1, published 2021** — 20 commits, 51 open issues, 22 open PRs. MIT, not archived, simply finished |
| `eventsource-parser`              | Actively maintained (3.1.0, MIT, 2026-05). Parser only — replaces the part we already have, not the part we're missing                                         |
| Token in the URL                  | Makes `EventSource` work, and puts a credential into URLs, server logs and browser history                                                                     |
| Cookie authentication for streams | Also makes `EventSource` work, and needs a second auth mechanism server-side, contradicting [ADR-024](ADR-024-browser-oidc-client-and-token-handling.md)       |

## Decision

**Use fetch + `ReadableStream`, extending the reader `tcp-cli` already has, and move it into `@tcp/shared/client`.**

Both clients then parse the stream through one implementation, so the CLI and the browser can't drift on what an event means.

- **HTTP/2[^http2] is required — in development as well as production.** Not a nicety; see [why](#http2-is-required-in-development-too).
- **One [subscription manager](#a-subscription-manager-owns-every-connection) owns every connection**, shared between components and capped.
- **Events [update the query cache](#how-events-map-to-the-cache); transcripts don't.**

The Microsoft library is the strongest alternative and is [rejected on maintenance age](#why-not-the-microsoft-library), not on capability.

[^http2]: The second version of HTTP. It carries many requests over one connection ("multiplexing"), which removes the six-connection limit that applies per address under HTTP/1.1.

## Consequences

- `parseWireEvents` and `wire-parse.ts` move from `tcp-cli` into `@tcp/shared/client`, and the CLI imports them from there. A small change to a working client, done for real reuse.
- HTTP/2 becomes a hard requirement of the development environment, not just the deployment. It needs checking early — the symptom is indistinguishable from a server fault.
- The subscription manager is infrastructure that must exist **before** the second streaming surface. Built late, every consumer needs rewriting.
- Reconnection correctness depends on the server continuing to prime the company and task streams with current state. That's now load-bearing for the client and shouldn't be removed without revisiting this ADR.
- **Whether a minimised chat keeps streaming is a decision, not a detail.** Four minimised chats plus a task dialog plus the live view is the connection ceiling again. The chat dialog prompt specifies it.
- An open stream outlives token expiry ([ADR-024](ADR-024-browser-oidc-client-and-token-handling.md)). Reconnecting re-authenticates; a stream that never drops does not.
- Announcements to screen readers are driven from the same events, but their timing belongs to [ADR-027](ADR-027-screen-reader-strategy.md), not here.

## Alternatives considered

- **`@microsoft/fetch-event-source`.** The strongest alternative — it supplies exactly the reconnection we lack. Rejected on maintenance age, and because it would leave two parsers for the same format in one repository. See [Detail](#why-not-the-microsoft-library).
- **`eventsource-parser`.** Maintained and widely used, but parser-only. It replaces the 30 lines that already work and leaves the 40–60 lines that don't exist — it solves the part of the problem we don't have, not the part we do.
- **Token in the query string.** The only route to using `EventSource` with no server change. Rejected: bearer tokens in URLs get logged by proxies and kept in browser history.
- **Cookie authentication for stream routes.** Also enables `EventSource`, and needs a parallel server-side auth mechanism plus a session, contradicting ADR-024.
- **Polling instead of streaming.** Sidesteps the connection limit entirely. Rejected — live observation is the capability the web client exists to provide ([ADR-020](ADR-020-web-ui-mvp-scope.md)).
- **One multiplexed stream endpoint.** A single connection carrying everything the user is watching would remove the limit without HTTP/2. A substantial server-side change to ADR-015's model; the natural answer if HTTP/2 ever proves unavailable, and not needed otherwise.

## Prompts to update when this is decided

- `002.03.00.prompt - static hosting and runtime configuration (draft).md`
- `005.02.00.prompt - sse client and event handling (draft).md`
- `007.01.00.prompt - company live activity view (draft).md`
- `008.01.00.prompt - dialog framework and event transcript components (draft).md`
- `008.02.00.prompt - chat dialog (draft).md`
- `008.03.00.prompt - task dialog (draft).md`
- `008.04.00.prompt - user response dialog (draft).md`

## Detail

### One event type, not three

Every stream carries the same union, `WireEvent`:

```text
{ type: 'audit', event: AuditWireEvent } | StreamDelta
```

Which entity an event concerns is discriminated at runtime on `payload.entity`. There are no separate agent, company and task event types to model.

`parseWireEvents` (in `apps/backend/apps/tcp-cli/src/lib/core/sse.ts`) imports only a _type_ from `@tcp/shared`, so it moves to the client export verbatim.

### Why not the Microsoft library

It genuinely supplies what the existing 73 lines lack — backoff, page visibility handling, `Last-Event-ID`, a proper lifecycle. That's the honest case for it, and it isn't weak.

It's rejected because the remaining gap is smaller than it looks and the dependency is larger than it looks:

- The gap is **reconnection alone**, perhaps 40–60 lines.
- The server already **primes** company and task streams with current state on subscribe, and `AgentController.replayTerminal` synthesises a terminal event for late subscribers — so catching up after a reconnect is substantially solved server-side already.
- `navigator.onLine` and the `visibilitychange` event come free from the browser.
- The package hasn't shipped in over five years, and would sit directly under the application's flagship feature.
- Adopting it would leave two parsers for the same wire format in the repository — its own, and the CLI's.

The backoff policy and the subscription manager have to be specified by this ADR regardless of who owns the socket, so the library wouldn't remove that work either.

### HTTP/2 is required, in development too

Browsers cap concurrent connections at six per address under HTTP/1.1. As noted above, five connections is an ordinary working state. HTTP/2 carries them over one connection and removes the ceiling.

This must hold in development. `vite dev` serves HTTP/1.1 by default, and the failure mode is the worst kind: **requests simply hang, with no error**, looking exactly like a backend fault.

The development server and preview server need HTTP/2 enabled, not just the production nginx image ([ADR-029](ADR-029-spa-hosting-and-runtime-configuration.md)).

### A subscription manager owns every connection

Several components can want the same stream — two panels showing the same agent, or a list and a dialog both watching a task.

One manager, keyed by stream URL, holds a single connection per key with a count of its subscribers. It opens on the first subscriber and closes after the last.

It also enforces a hard connection cap, so an unexpected fan-out fails as a logged, bounded refusal rather than silent browser-level queuing.

### Reconnection

On a dropped connection: reconnect with exponential backoff and jitter, capped, and reset the delay after a successful read.

Suspend retries while `navigator.onLine` is false or the document is hidden, and retry immediately when either flips back.

Recovery comes from the server's priming rather than client-side bookkeeping — the endpoints already prime, so a reconnected company or task stream re-renders correctly on its own.

Each connection attempt fetches a fresh token ([ADR-024](ADR-024-browser-oidc-client-and-token-handling.md)), so renewal happens as part of reconnection.

### How events map to the cache

Events carrying an entity summary — a `state_change` with a `TaskChangeSummary` or `AssignmentChangeSummary` — **patch** the matching query cache entry directly. The payload is the same shape a list row renders from, so no refetch is needed.

Events without a usable summary invalidate their query key instead, and the cache refetches.

`StreamDelta`s don't touch the cache at all. They're high-frequency, append-only, and belong to one open transcript, so they go to local component state ([ADR-021](ADR-021-web-ui-framework-and-architecture.md)).

---

## Amendment as implemented (008.02) <a id="amendment-as-implemented-00802"></a>

This ADR said the connection budget mattered but left the number of streams a
surface may hold to whoever first opened more than one. That was the chat dialog
([008.02](../prompts/phase%2002%20-%20web%20ui/008.02.00.prompt%20-%20chat%20dialog.md)),
and this is the policy it settled. **008.03 and everything after it apply this
rather than deciding again.** The same four rules are written beside
`MAX_STREAMS` in `apps/frontend/tcp-frontend/src/events/subscriptions.ts`, so
either place finds them.

### One stream per mounted transcript, and nothing else opens a stream

A page owns at most one — `CompanyPage` and its company stream. A dialog owns
one per visible conversation or panel. No hook opens a stream
([ADR-030](ADR-030-component-hooks-for-live-data.md)).

There is deliberately **no per-surface quota**. A second cap would have to be
kept in step with the real one, and the real one already fails loudly: a
transcript refused by `MAX_STREAMS` renders `at-capacity` as its own message, in
place, while its siblings keep working.

### A parked stream releases its connection

Parked means unmounted: a minimised chat dialog, a collapsed assignment panel.
Nothing holds a connection open for a surface the user cannot see.

This is what makes minimising free, and it is why the dock button for a parked
chat can still name its agent's status — that value comes from the query cache
some other open stream is patching, not from a connection of its own.

### A restored one catches up by re-priming, not by replay

Remounting refetches the agent's history, rebuilds the transcript from it, and
only then subscribes; the server synthesises a terminal event for a late
subscriber. Nothing is held across the park.

Token deltas that arrived while it was parked are lost, and that is correct —
they were never persisted, and the completed response they were building is in
the history.

### `MAX_STREAMS = 12` still stands

005.02 picked the number before any view opened more than one stream, and asked
for it to be rechecked at this point. With parked streams released, the
realistic worst case is one company stream plus a handful of open panels, so
reaching twelve means a fan-out bug — which is what the cap is for. HTTP/2 is
mandatory ([ADR-029](ADR-029-spa-hosting-and-runtime-configuration.md)), so the browser's
own six-per-origin HTTP/1.1 ceiling does not bind.

This closes the open consequence above: whether a minimised chat keeps streaming
is decided, and the answer is that it does not.

## Amendment as implemented (002.02, phase 03) <a id="amendment-as-implemented-p03-002-02"></a>

A user report — a new task's agent avatar appeared late, then looked idle
with an empty listen-in while the task read "planning" — turned into a
reproduction with recorded SSE streams and DB state side by side (the
plan's stage 1 "As found" note). The office wasn't behind the server: the
agent really was idle, queued behind `AGENT_WORKER_CONCURRENCY`'s one
worker slot. But the reproduction also found a real gap this ADR's
[cache-mapping rule](#how-events-map-to-the-cache) didn't cover, and
confirmed two of its own open questions were narrow enough to leave open.

### Every agent status change now publishes an event, after its write

Before this, several writers changed an agent's status with no
`state_change` at all, or published one before the row was actually
written:

- **Silent:** creating an agent, linking an assignment's `agentId` back to
  it, the QA hand-off pause, and cancel.
- **Early:** resume published `running` as soon as the job was enqueued,
  which could read `running` on a client while the database still said
  `paused` if the one worker slot was occupied. Chat failure published
  before its write landed.

A client's only way to learn an agent existed at all was its first
`running` event — instant on an idle system, but up to the length of
whatever was ahead of it in the worker queue otherwise. All of the above
now publish an agent (or assignment, for the back-link) `state_change`
**after** its write, reusing the `recordStatus` pattern
`pause-and-resume.service.ts` already had. Resume's early `running` publish
is deleted outright — the worker's own `running` write already covers it,
and publishing twice was strictly worse than publishing once, correctly
timed.

### A patch no longer loses to a fetch that started before it

`applyEvent` (`cache.ts`) patches the matching cached row, but didn't
account for a list fetch already in flight — one that read the database
_before_ the write landed. That response could arrive after the patch and
silently overwrite it with stale data. `applyEvent` now checks
`queryClient.isFetching` for the entity after patching, and invalidates if
one is in flight; the default `cancelRefetch` drops the stale request and
triggers a fresh one after the write. This is
[web-client.md](../web-client.md#event-client)'s "C2" guard, confirmed by a
test where a list fetch in flight when a patch lands ends with the fresh
status rather than the stale one.

### Two narrower replay races, confirmed but not seen, left open

The reproduction went looking for two more candidates this ADR's
[reconnection](#reconnection) design could in principle allow, and found
neither occurred in either recorded run:

- **A subscribe-time `idle` replay landing after a live `running`.** The
  agent stream's replay-on-subscribe (`api.agent.controller.ts`) reads the
  database at subscribe time; if that read raced a live event, the stale
  reading could in principle land after the real one. Both recorded runs
  subscribed to a genuinely idle agent, so the replay and the database
  agreed throughout.
- **An event lost between company-stream priming and the live
  subscription.** The company stream did not reconnect in either run, so
  the gap this would depend on never opened.

Neither is disproven — they're narrow windows that this reproduction's two
runs didn't happen to hit, not races that were ruled out. Reworking the
agent-stream replay or the priming order to close them stayed out of scope
rather than being taken on speculatively; both are tracked as unresolved
notes with a testable recheck condition (phase 03's
[unresolved notes](<../prompts/phase 03 - web visualisation/unresolved-notes.md>)).
