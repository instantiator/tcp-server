# Unresolved notes from phases 01–03

What the completed phases (01 service, 02 web UI, 03 web visualisation) left
open. Gathered on 2026-10-04 from both phases' `unresolved-notes.md` files and
from every plan and prompt in all three phases, then checked against the code.

Left out, because they're recorded elsewhere or done:

- anything since implemented
- anything already written into a future prompt (phases 04–06, including
  [phase 05's unplanned list](<phase 05 - service quality/unplanned.md>))
- anything in [deferred-work.md](deferred-work.md), which stays a separate list
  of things observed in use
- defects in [outstanding-issues.md](../outstanding-issues.md)

Not a feature backlog. These are compromises taken knowingly, constraints from
outside, and decisions that can only be taken once something else exists.

## How to use it

- **Resolve an entry by deleting it**, in the change that resolves it. An entry
  kept for the record is an entry nobody trusts is current.
- **Work a later prompt will do** goes into that prompt, not here.
- **An entry whose trigger is a condition**, not a date, needs a memory too,
  because nothing in the repo will prompt anyone to re-check it.
- **Phases 04 onward keep their own** `unresolved-notes.md` in their phase
  directory while they run.

Each entry says which phase and prompt raised it, and the condition that should
make someone revisit it. Entries are grouped by area, not by phase.

## Agents and orchestration

### Dead-letter queue for permanently-failed jobs

**Raised by:** phase 01, 010.01 · **Condition to revisit:** A BullMQ job repeatedly fails and silently vanishes rather than surfacing for operator attention — i.e. the first time this bites in practice

When a BullMQ job for an agent run exhausts its retries, there's no dead-letter queue to catch it for inspection — it just fails. This was named as remaining work when ADR-010 was marked "sequential orchestration implemented" but was dropped from later summaries and never built.

Testable: grep `apps/backend/apps/tcp-agent` for any DLQ/failed-queue handling — none exists.

### QA runs per assignment, by the same role

**Raised by:** phase 01, 010.01 · **Condition to revisit:** an assignment produces several outputs that need separate verdicts, or a company wants QA done by a different role

QA today runs once per assignment (accept promotes everything and advances; reject retries the whole assignment). The original design space included QA per individual output item within an assignment; that finer granularity was never built and nothing has needed it since. This is a minor, low-confidence gap — the architecture may simply have made it unnecessary.

Testable: `TaskOrchestrationService`'s QA reaction operates on `assignment`, not on individual artifacts within one.

**Also:** The QA agent for an assignment is always a fresh instance of the same role that did the work — there's no separate "QA role" concept per company. This was a recorded decision with an explicit "future work" label at the time, and nothing has revisited it since.

Testable: `TaskOrchestrationService`'s QA dispatch creates an agent with the assignment's own `roleId`, not a distinct QA role.

### ADR-013 context-management residual gaps

**Raised by:** phase 01, 005.01 · **Condition to revisit:** Essential-information anchoring — when aggressive message dropping starts losing decisions/commitments in practice (explicit condition already in the code comment). The other two have no stated trigger

Three related context-management gaps remain from the original design: pre-fetched MCP responses were never added as prompt part 6; before dropping messages for budget reasons, the compactor doesn't extract and anchor essential facts first (it just drops); and context budget thresholds are global, not configurable per role. All three are explicitly tracked in the ADR and in `docs/index.md` but have no plan to build them.

Testable: the TODO at `context-compactor.service.ts:80` and `docs/index.md`'s ADR-013 gaps column.

### ADR-012 human-in-the-loop gaps (user-initiated conversations, WebSocket upgrade, teaching flow)

**Raised by:** phase 01, 008.02 · **Condition to revisit:** User-initiated conversations — a user wants to start a conversation with a role without an existing task/agent context. WebSocket — SSE+POST genuinely can't serve some future interaction pattern. Teaching flow — users want a structured way to push a correction straight into memory/knowledge from a reply, rather than it staying conversational

Three items from ADR-012's original "Deferred" list are still open five phases later: starting a conversation with a role with no running task behind it; a literal WebSocket transport (the chat UX need itself was met differently, via SSE+POST); and a `{ teach: ... }` reply flag that would let a user's response go straight into memory or knowledge rather than just the conversation.

Testable: `docs/ADRs/ADR-012-human-in-the-loop.md`'s "Deferred" section still lists all three; no `teach` field exists on any conversation reply DTO.

### `resolveRunConfig`'s per-field precedence pattern never unified

**Raised by:** phase 01, 009.01 · **Condition to revisit:** Someone needs to add a third config-resolution shape and wants to avoid a fourth one-off pattern

This is a minor, low-priority note: `resolveRunConfig`'s per-field precedence over `AgentRunConfig` uses a different shape than the other config resolvers (`LlmConfigResolver`/`SystemPromptTemplateResolver`), and could theoretically be rebuilt on the same shared base. The plan asked only that this be written down as a follow-up opportunity; even that documentation step seems not to have happened.

Testable: no doc mentions this as a known inconsistency.

### Per-role agent concurrency limits not implemented

**Raised by:** phase 01, 003.01 · **Condition to revisit:** Different roles need different concurrency ceilings (e.g. a role bound to a rate-limited remote API vs. one hitting a local model)

Worker concurrency (how many agent jobs tcp-agent runs in parallel) is one global number for the whole deployment, not configurable per role. The original plan hardcoded 5 (now defaulted to 1) with an explicit note to revisit once per-role resource limits existed — they still don't.

Testable: `AGENT_WORKER_CONCURRENCY`/`DEFAULT_AGENT_WORKER_CONCURRENCY` apply globally; no per-role override exists in the config schema.

### Loop-spine extraction (chat vs. worker shared core) deferred

**Raised by:** phase 01, 010.01 · **Condition to revisit:** A third operation path appears beyond "chat" (interactive, no terminal handling) and "worker" (BullMQ job, full terminal/retry handling) — the plan's own explicit trigger

The chat and worker paths share the real execution core (`runSupervisedGraph`) but still duplicate the surrounding "spine" logic (required-tool enforcement, empty-output retry, terminal status handling) in two places, because that spine is almost entirely worker-only behaviour that chat deliberately skips. Full extraction was judged likely to produce a one-behaviour-per-arm wrapper rather than real consolidation, so it was deferred with an explicit revisit trigger.

Testable: only one caller of `runSupervisedGraph` exists today — the trigger condition (a third path) hasn't fired.

### Full LLM-based `summarise_file` never built

**Raised by:** phase 01, 006.02 · **Condition to revisit:** A real use case appears where the structural summary (file type, size, line/row counts) isn't enough for an agent to decide whether to open a file

The original plan wanted a real LLM call to summarise file contents; what shipped instead is `get_file_summary`, which reports structural facts only (no content understanding). Nobody has revisited whether that's good enough.

Testable: grep the codebase for `summarise_file` or an LLM call inside the storage MCP server — there is none.

### Memory scrubbing, consolidation, and RAG-context MCP tools never built

**Raised by:** phase 01, 001.01 · **Condition to revisit:** A company's agent memory grows large enough that unscrubbed, unconsolidated memory starts degrading recall quality or privacy compliance requires deletion-by-date/topic/task

Three related memory features were designed at the very start of the project but never built: an API to delete memories by date range/task/topic, a periodic job that consolidates episodic memories into role knowledge, and the two MCP tools for updating/condensing RAG context mid-conversation. All three remain open five phases later.

Testable: grep `tcp-mcp-memory` for `scrub`, `consolidat`, `update_rag_context`, `condense_rag_context` — none exist.

### OKF spec adoption stayed minimal (title-only)

**Raised by:** phase 01, 010.06 · **Condition to revisit:** Richer knowledge metadata (structured sections, ids, relations) is actually needed — the original note frames this as optional, not urgent

The plan adopted only the `title` field of the real OKF spec, flagging richer adoption as "a future option if richer metadata is ever needed." Nothing since has needed it, so it's stayed minimal. Low priority by its own original framing.

Testable: `docs/glossary.md`'s OKF entry still names only `title`.

## Live data and event streams

### Every agent state change now reaches every subscriber of that company's stream

**Raised by:** phase 02, 002.04 · **Condition to revisit:** the live view is reported as noisy, or one company routinely runs enough concurrent agents for the stream to be the bottleneck

Before 002.04 the company channel carried only `company` and `task` rows —
`CompanyEventService`'s comment said agent and assignment rows were filtered out
deliberately, to protect the roster TUI from volume. Widening the predicate to
five entities removed that protection: an agent's every status transition now
fans out to every open company stream.

No filtering, sampling or coalescing was added, because there is no measurement
yet to size it against and a filter chosen blind is a filter that hides the wrong
rows. Recorded in the memory `project-company-stream-volume`, because nothing in
this repository will surface it on its own.

### Reconnection correctness is load-bearing on server-side priming

**Raised by:** phase 02, 005.02 · **Condition to revisit:** any change to `CompanyPrimingService.prime`, `TaskController.primeTaskEvents` or `AgentController.replayTerminal` — this needs ADR-025 revisited, not just a test fixed

The client keeps no bookkeeping across a drop: no last-seen id, no replay buffer. A reconnected stream re-renders correctly only because the company and task streams keep priming with current state on every subscribe, and the agent stream keeps synthesising a terminal event for a late subscriber. That coupling is recorded in ADR-025, not enforced by any type the client and server share.

**Also (phase 03, 002.02: the priming gap, C4):** `api.company.controller.ts` awaits `prime()` — sending one row per current
task, active agent, open consultation and open enquiry — before it starts
forwarding live events. A `state_change` published in the gap between the
primed snapshot being read and the live subscription starting would reach
neither. 002.02's reproduction didn't see the company stream reconnect at
all, so this gap never opened in either recorded run. See
[ADR-025's amendment](../ADRs/ADR-025-browser-event-stream-consumption.md#amendment-as-implemented-p03-002-02).

Testable: force a company-stream reconnect (network drop, tab backgrounded
then foregrounded) at the same moment a status changes server-side, and
check whether the office view or activity lists ever miss it.

### The transcript misses events between its history snapshot and its subscription

**Raised by:** phase 02, 008.01 · **Condition to revisit:** an event is observed to be missing in practice, or 008.02/008.03 need the gap closed.

The transcript primes from `GET /api/agent/{id}/history` and only then subscribes, because interleaving the two sources correctly would mean buffering one of them. The agent stream synthesises a terminal event for a late subscriber, which covers the case that matters most. Closing the gap properly means buffering live events until history has been applied.

**Also (phase 03, 002.02: the agent stream replay race, C3):** `api.agent.controller.ts`'s agent stream reads the agent's status from the
database at subscribe time and replays it as a synthetic event, so a late
subscriber sees where things stand rather than nothing. If that read races a
real `state_change` landing at the same moment, the stale reading could in
principle arrive after the live one and read backwards. 002.02's
reproduction (recorded SSE streams and DB state side by side, twice) didn't
hit this — both replays agreed with the database throughout — so it's
recorded rather than fixed speculatively. See
[ADR-025's amendment](../ADRs/ADR-025-browser-event-stream-consumption.md#amendment-as-implemented-p03-002-02).

Testable: open a listen-in on an agent at the exact moment it changes
status, and check whether the tray or transcript ever shows the older
status after the newer one.

### Live agent rows are patched from a reconstructed summary

**Raised by:** phase 02, 007.01 · **Condition to revisit:** the agent `state_change`
writers start attaching an `AgentChangeSummary`. Testable: `grep -rn "entity:
'agent'" apps/backend --include=*.ts` shows a `summary` alongside.

`synthesiseAgentPatch` in `src/events/cache.ts` exists because 002.04 widened
the company channel's routing predicate to include `agent` rows but did not
change the roughly eight places that write one — several of them in
`tcp-agent`, across a process boundary. So a **primed** agent row carries an
`AgentChangeSummary` and a **live** one carries nothing but `event.agentId`
and `payload.newStatus`. Without the reconstruction, agent status — the
highest-frequency event on the company stream — would be the one change that
refetches an entire list instead of patching the row it names.

It becomes dead code silently the day those writers start sending a real
summary, because `applyEvent` prefers `hasStringId(summary)` and only falls
back to `synthesiseAgentPatch` when that is absent — nothing needs to notice
or remove the fallback for the fix to take effect.

**Also (phase 03, 000.01: the office view works around the same gap):** `companySnapshot.ts`'s activity mapping deliberately reads whether an agent is
consulting or messaging the user from the consultee assignment and the open
enquiries, never from `agent.pauseReason`. A live agent event patches only
`status` into the cached row, so `pauseReason` goes stale the moment an agent
changes state after the page loaded. See the memory
`project-live-agent-rows-no-summary`.

Testable: `grep -rn "entity: 'agent'" apps/backend --include=*.ts` shows a
`summary` alongside every write.

### `MAX_STREAMS = 12` is a guess

**Raised by:** phase 02, 005.02 · **Condition to revisit:** the first time a real view is refused, or when 007.01 establishes an actual per-view stream count

Picked as twice HTTP/1.1's six-per-origin ceiling, with headroom for a live view plus several dialogs — not measured against anything built. No view yet opens more than one stream, so the number has never been tested against real usage.

**007.01 was the first real view, and it opened zero additional streams.** The
live activity view reuses `CompanyPage`'s single existing company subscription
and reads the four lists off the TanStack Query cache that subscription
patches — `CompanyActivity` opens no `useEventStream` of its own. So the
condition to revisit is still untriggered, and the constant was not raised.
Recorded explicitly so this reads as "checked, still true" rather than "not
checked."

**Also (phase 02, 008.02):** No per-surface quota sits on top of `MAX_STREAMS = 12`. That is deliberate: a second cap would have to be kept in step with the real one, for no benefit, and the real one already fails loudly — a refused transcript renders `at-capacity` as its own message, in place, while every other open panel keeps working.

Testable: twelve streams are open at once through ordinary use — not a bug that opens streams nobody asked for — and a thirteenth is refused. If that happens, the change to make is a cap on how many conversations or panels may be open at once, not a larger `MAX_STREAMS`; raising the constant blind would only move the same failure further off, unmeasured.

### The activity view fetches four lists the stream had already primed

**Raised by:** phase 02, 007.01 · **Condition to revisit:** the mount cost of the four
requests becomes measurable, or a second view needs the same four lists.
Testable: the browser network panel shows a list refetched within a second of
its first response.

The originating prompt said the view should "render from the stream's
priming, without a separate fetch." It does not: `AgentsList`, `TasksList`,
`ConsultationsList` and `EnquiriesList` fetch through `useAgents`, `useTasks`,
`useAssignments` and `useConversations`, and the company stream's events then
patch what those hooks cached. This is ADR-025's architecture, not a
deviation from it — `useEventStream` never exposes audit events to a caller,
it folds every one into the TanStack Query cache via `applyEvent`, and
priming's documented role there is reconnect recovery, not initial render.

Rendering from priming directly would have needed `useEventStream` widened to
expose events, a second source of truth beside the cache that 008.x's dialogs
also read, and — decisively — the event collection lifted out of the activity
view and into `CompanyPage`, because `CompanyActivity` mounts inside the
`company !== undefined` branch, _after_ the subscription already opened, and
would therefore miss its own priming. The alternative was rejected for that
timing reason, not because it was more effort.

### `TaskChangeSummary` carries fields `TcpTask` does not

**Raised by:** phase 02, 007.01 · **Condition to revisit:** a view wants to show
`completedSteps`/`totalSteps`. Testable: `grep -rn 'completedSteps'
apps/frontend/tcp-frontend/src` matches outside `api/schema.d.ts`.

A stream patch merges whatever fields its summary carries onto the cached
row, and `TaskChangeSummary` carries `completedSteps`/`totalSteps` that
`TcpTask` — the REST shape `useTasks` fetches — never had. So such a field is
absent on first paint and materialises only after the first matching event,
which is worse than a field that was never shown at all: the row's shape
changes under a reader for no reason they can see. `TasksList`
(`src/pages/CompanyPage/activity/lists.tsx`) deliberately renders neither
field, with a comment at the point they would go.

### Creating a task publishes no live event

**Raised by:** phase 03, 000.01 · **Condition to revisit:** `TaskService.create` publishes a `ready` state_change

`TaskService.create` saves the task row and records nothing, so an open page
sees a new task only once it is started (`planning` is published) or on
reload. This affects the office view — its browser spec creates a task before
opening the page, and tests live _removal_ only — and the Tasks tab for
every other viewer too, not just this one.

No prompt owns this backend fix yet.

Testable: create a task through the API while a page showing the office view
or the Tasks tab is open. The task does not appear until it is started or
the page is reloaded.

### The consultations list is an approximation

**Raised by:** phase 02, 002.04 · **Condition to revisit:** a `PendingConsultation` controller, or a consultation audit entity, exists

`GET /api/assignment?companyId=X&taskId=null&mode=consultee` lists consultee
assignments, not pending consultations. Every consulting agent works an orphan
consultee-mode assignment, so a consultation that has started appears — but one
that has been _requested_ and not yet picked up has no assignment at all, and is
invisible.

That is acceptable for the MVP list and is why 007.01 must not present it as
complete. When either a `PendingConsultation` controller or a consultation-level
audit entity exists, both the query and 007.01's wording change together.

007.01 does not leave the list to speak for itself: `ConsultationsList` passes
`note={t('activity.consultations.partial')}` to `ActivityList`, which renders
the caveat as a visible `<p>` above the rows and, deliberately, outside the
`aria-busy` region — a standing fact about the list, not loading content, so it
survives all four of the list's states rather than vanishing whenever the list
is fetching, failed or empty.

`useLiveConsultationState` (added in 007.02) inherits the same limit: a
consultation that has been requested but not yet picked up has no assignment
row, so there is no id to pass it.

### Token-delta coalescing over Redis never built

**Raised by:** phase 01, 008.03 · **Condition to revisit:** The per-chunk Redis publish pattern measurably lags under real load (the plan's own stated trigger)

Streaming responses publish one Redis message per token delta rather than batching/coalescing them. This was accepted deliberately, with an explicit "only fix if it measurably lags" condition, and nobody has reported lag since.

Testable: grep the SSE/Redis publish path for any batching logic — there is none.

## Security and access

### Endpoint security policy never written as an ADR

**Raised by:** phase 01, 003.01 · **Condition to revisit:** Any point where someone needs a single authoritative doc for the auth/guard policy rather than tribal knowledge

The policy itself (guard every new controller by default, JWT on all user-facing routes, very few public endpoints) was actually built and is enforced today by `route-audit.spec.ts` (`apps/backend/apps/tcp-server/src/auth/route-audit.spec.ts`). What's missing is purely the write-up: there's no ADR recording the decision and its rationale, even though the practice is real and tested.

Testable: `docs/ADRs/` has no ADR titled or themed around endpoint security.

### Audit trail can't trace agent-initiated storage actions to a requesting human

**Raised by:** phase 01, 009.02 · **Condition to revisit:** Someone needs to audit "which human ultimately caused this file write" — e.g. for compliance or incident investigation

When an agent writes/deletes a storage file via an MCP tool call, the audit record's `originators.user` field is always null — there's no chain from the tool call back through the agent, assignment and task to the human who originally requested the work. ADR-010's task model was built specifically without closing this loop.

Testable: `TcpTask.model.ts` has no requesting-user field, and any storage audit event from an agent-initiated write will show `originators.user: null`.

### JWT `clockTolerance` not configured

**Raised by:** phase 01, 009.01 · **Condition to revisit:** A real deployment sees spurious JWT validation failures traceable to clock skew between the OIDC provider and tcp-server

This is a minor, low-priority note flagged as "optional future follow-up only" at the time — no code change was intended, just documentation. Zero clock tolerance means a JWT issued a moment before or validated a moment after its `exp`/`nbf` boundary, under real clock skew, could be wrongly accepted or rejected. Nobody has reported this in practice.

Testable: `jwt.strategy.ts`'s `JwtStrategy` constructor options have no `clockTolerance` key.

### A 403 confirms that a company, task or agent exists

**Raised by:** phase 02, 002.05 · **Condition to revisit:** id enumeration becomes a
realistic threat — a public deployment, or ids that are guessable rather than
UUIDs

Membership refusals are `403` everywhere, and a `404` means the handle names
nothing. That is deliberate: collapsing both into `404` would make every genuine
permissions problem look like a missing record, which is precisely the debugging
confusion ADR-011's amendment warns about. The cost is that a caller can learn
whether an id exists by the code they get back.

With v4 UUIDs and a private deployment that is not worth trading legibility for.
It stops being true if ids become enumerable or the deployment becomes public.

### `TCP_ADMIN_IDENTIFIERS` is a flat list in the environment

**Raised by:** phase 02, 002.05 · **Condition to revisit:** permission groups exist (the
work carried into `002.01` (phase 06))

"System administrator" had to mean something before `?all=true` and the
`/api/system` routes could be gated, and permission groups do not exist yet. A
comma-separated list of `sub` claims and email addresses is the interim answer:
fail-closed by default, written by the Zitadel bootstrap for local development,
set by hand against an external provider.

Its limits are real — changing it needs a restart, it is invisible from the API,
and it cannot express anything finer than "everything". It should be replaced by
whatever the permission-flag work builds, not extended.

Related, and kept separate: `deferred-work.md` ("Default admin user provision") covers how the first admin is assigned.

### Membership matching trusts the token's `email` claim unconditionally

**Raised by:** phase 02, 002.05 · **Condition to revisit:** an identity provider is used
whose users can set their own email address without verification — anything
other than the bundled Zitadel with its default policy

A `CompanyUser` row may be keyed by an OIDC `sub` **or** an email address, and
enforcement matches on both — ADR-011 requires it, because matching on `sub`
alone denies email-keyed members silently. The cost is that the `email` claim is
now an access-granting identifier: a provider that will mint a token carrying an
arbitrary, unverified `email` hands the bearer every email-keyed membership for
that address.

`email_verified` is not checked. Requiring it would close this, and would break
every email-keyed membership if a provider omits the claim — which is why it was
not changed blind at the end of 002.05. Before trusting a new provider, confirm
what it puts in `email` and `email_verified`, and gate on the latter if it is
reliably present. Recorded in the memory `project-membership-enforcement`.

### The renewal and the sign-in are the same redirect

**Raised by:** phase 02, 004.01 · **Condition to revisit:** the `sessionStorage` fallback in [ADR-024](../ADRs/ADR-024-browser-oidc-client-and-token-handling.md) is taken, so a refresh token exists. Testable: `offline_access` appears in `createUserManagerSettings().scope`.

ADR-024 asks for one renewal attempt, then a redirect to sign-in if that fails. Both halves need something to renew _with_, and this client has nothing: no refresh token, because that is the basis of the in-memory decision, and no hidden iframe, because the ADR rejected the mechanism. So `handleUnauthorized()` makes a single `signinRedirect()` and lets the provider decide. Against a live provider session it returns a fresh token with no form shown, which is the renewal; against an expired one it shows the login page, which is the sign-in.

This is correct only while no refresh token exists. Taking the `sessionStorage` fallback would make a genuine two-step policy possible, and the single call would then be hiding a step rather than collapsing one. Recorded as amendment (a) on ADR-024.

### The local browser client is registered with Zitadel `devMode` on

**Raised by:** phase 02, 004.01 · **Condition to revisit:** the first deployment on a hostname that is not `localhost`

`devMode: true` relaxes Zitadel's redirect-URI validation, which is what lets a self-signed `https://localhost:<port>` registration work at all. It is correct for a bootstrap that only ever targets the bundled localhost instance, and wrong for anything else — a real deployment registers its client by hand, and `docs/authentication.md` now says what to register. The risk is not that the setting is wrong today; it is that `start-deployment.sh` is the obvious thing to copy when a real deployment is first stood up.

Recorded in the memory `project-zitadel-web-client-devmode`.

### The PKCE verifier and `state` are in `sessionStorage`, so "nothing in browser storage" is not literally true

**Raised by:** phase 02, 004.01 · **Condition to revisit:** anything else starts writing to `sessionStorage` under an OIDC key, at which point matching on token strings alone stops being sufficient

Tokens are held in an in-memory store, but the PKCE verifier and the `state` nonce cannot be: they have to survive the navigation to the provider and back. Neither is a credential — single-use, scoped to one sign-in, and worthless to an attacker who cannot also receive the callback — so this is a correct configuration rather than a compromise. It is recorded because the shorthand people will remember is "no OIDC material in browser storage", and the test asserts the narrower, accurate property: that no _token_ is.

### The allow-list of return destinations is maintained by hand

**Raised by:** phase 02, 004.02 · **Condition to revisit:** a third route goes behind `RequireSession`, or the route table in `App.tsx` stops fitting on one screen. Testable: count the guarded routes in `App.tsx` against the entries in `RETURNABLE_ROUTES`.

`safeRedirectTarget()` refuses any destination that is not one of the routes named in `RETURNABLE_ROUTES` (`src/auth/redirect-target.ts`). That list cannot simply be the route table: the catch-all `*` matches every address, and `/` and `/callback` are both the redirect loop, so an allow-list derived from the table would allow exactly what it exists to refuse.

Deriving both from one shared array is the fix, and it was not worth the indirection for two entries. The failure it leaves is mild and silent — a route added later and not listed still works, but a user sent there before signing in arrives at `/companies` instead, with nothing to say why. Written into `006.01`, which is the next prompt to touch those routes, and recorded in the memory `project-oidc-callback-and-return-routes`.

### Signing out in one browser tab leaves the others looking signed in

**Raised by:** phase 02, 004.03 · **Condition to revisit:** `monitorSession` becomes usable without third-party cookies, or someone reports a stale tab. Testable: `check_session_iframe` appears in the provider's discovery document _and_ the browser still delivers the provider's cookie to an iframe on this origin.

Tokens are per-tab, because the store is per-tab: an in-memory user store is not shared, and neither is anything derived from it. So signing out in one tab ends that tab's session and the provider's, but a second tab keeps its own copy of a user the provider no longer recognises. Its header still offers an account menu, and it stays that way until its next request comes back 401 and `handleUnauthorized()` sends it to the provider, which by then has no session to return.

The two mechanisms that would close this are both rejected or unavailable. `monitorSession` is the library's own answer and works by polling a hidden iframe against the provider's `check_session_iframe` — the third-party-cookie mechanism [ADR-024](../ADRs/ADR-024-browser-oidc-client-and-token-handling.md) rejected for renewal, for the same reason it would fail here. `BroadcastChannel` would work and is a dozen lines, but it broadcasts a sign-out that a tab is free to ignore, and it buys a shorter window rather than a closed one — every tab still ends up correct at its next request either way.

So this is a compromise taken knowingly: the window is bounded by the next request, the failure is a menu that looks live rather than access that is, and no data is reachable through it. It becomes worth revisiting if a user meets it, or if the browser and the provider make the iframe approach honest again.

### Reload recovery has no cross-page-load loop counter

**Raised by:** phase 02, 004.03 · **Condition to revisit:** a provider is observed returning a user with no `sub`, or one already expired on arrival. Testable: `AuthSession` yields `null` for a user that `react-oidc-context` reports as authenticated.

`RequireSession` redirects to the provider when it has no session, which is the same shape of hazard `/callback` was written to avoid — a page that re-attempts sign-in on mount can bounce forever. Three things stop it here, and none of them is a counter: `handleUnauthorized()`'s module latch absorbs StrictMode's double mount and any second guarded component; the `failed` flag stops the effect re-firing after a rejection, which is the only way that latch reopens; and the provider's return leg always lands on `/callback`, which never redirects on its own.

The gap those three leave is narrow but real. A page load is where the latch resets, so the loop that survives is one that completes a round trip and still arrives with no session — which needs a provider that returns a user the exchange accepts but `AuthSession` maps to nothing. `sub` is mandatory in an ID token and `isAuthenticated` already excludes an expired user, so this is close to unreachable against a conforming provider, and a `sessionStorage` counter to guard it would have to be cleared on a successful sign-in or it would break the legitimate second recovery an hour later.

Left out deliberately, with the reasoning recorded in `session.tsx` beside the code rather than only here. An unreachable provider does **not** produce this: `signinRedirect()` rejects before navigating, and the guard shows an error with a manual retry.

### Vite's development server is exposed to the local network

**Raised by:** phase 02, 002.03 · **Condition to revisit:** a tighter bind becomes possible

`--dev-web` puts nginx in a container in front of `vite dev` on the host,
reaching it through `host.docker.internal`. That arrives on the host's bridge
interface, not on loopback, so `vite.config.ts` sets `server.host: true` and the
development port is open to the LAN.

Vite's own `allowedHosts` still refuses any request whose `Host` header isn't
localhost, so a scan of the port gets a refusal rather than source code. That is
a mitigation, not a fix. The port is open on whatever network the machine is on.

Binding only to the Docker bridge address would be tighter, and is not portable
across Docker Desktop and Linux — which is why it wasn't done. Worth revisiting
if a stable way to name that interface appears.

## API, data and storage

### The generated client was typed against entities the Swagger plugin never read

**Raised by:** phase 02, 006.01 · **Condition to revisit:** a new entity model is added
outside `libs/tcp-shared/src/models/*.model.ts`, or `dtoFileNameSuffix` in
`apps/backend/nest-cli.json` is edited. Testable: `grep -c 'Record<string,
never>;' apps/frontend/tcp-frontend/src/api/schema.d.ts` returns more than 2.

The `@nestjs/swagger` CLI plugin only synthesises `@ApiProperty` metadata for
files matching `dtoFileNameSuffix` (default `['.dto.ts', '.entity.ts']`). The
entities live in `libs/tcp-shared/src/models/*.model.ts`, which matched
neither default, so eight of them reached the web client as `Record<string,
never>` — a type with no properties at all — across 29 operations. The
failure is silent at its cause and surfaces only as a compile error at a call
site, in another package, whenever someone finally tries to read a field.
Fixed by adding `.model.ts` to the suffix list.

### The generated schema documents the persistence shape, not the wire shape

**Raised by:** phase 02, 006.01 · **Condition to revisit:** any API read path starts
passing `relations:`, or a model gains `eager: true`. Testable: `grep -rn
'relations:' apps/backend/apps/tcp-server/src/` returns a hit on a route the
web UI calls.

TypeORM relation properties are declared `!` because they are required _in
the database_, but no relation is eager-loaded and `relations:` appears in
only two non-route places (`chat.service.ts`, `system-drain.service.ts`). So
a response carries the foreign-key columns and not the related objects, and
the `OmitType` DTOs in `entity-response.dto.ts` encode exactly that, dropping
each unloaded relation while copying the rest of the model's metadata.
Nothing fails if it stops being true — the schema just quietly
under-describes the response.

### Optimistic locking missing on TcpCompany/TcpRole

**Raised by:** phase 01, 009.01 · **Condition to revisit:** Two concurrent writers to the same company or role record actually collide in practice (the residual race the original note flagged)

The 009.01.01 fix removed the delete-then-insert race for company/role updates, but a smaller race remains: two concurrent writers can both read the same `existing` row before either saves, and the second save silently overwrites the first's changes. `@VersionColumn()` optimistic locking would catch this (it's already used elsewhere in the schema) but was never added to `TcpCompany`/`TcpRole`.

Testable: `TcpCompany.model.ts`/`TcpRole.model.ts` declare no `@VersionColumn()`.

### MinIO JSONL audit export never built

**Raised by:** phase 01, 006.02 · **Condition to revisit:** Someone needs a human-inspectable, durable audit archive outside the database (e.g. for compliance export or DB-independent audit review)

ADR-008's hybrid design calls for Postgres `audit_events` (built) plus a JSON Lines export to MinIO per task step (not built). Audit events are fully queryable in Postgres today, so this mainly affects long-term archival/portability.

Testable: grep MinIO write paths for `.jsonl` — there is none; only the Postgres `audit_events` table is populated.

### XML/CSV schema-location validation still unbuilt

**Raised by:** phase 01, 009.02 · **Condition to revisit:** A user actually needs schema-level validation (not just well-formedness) for uploaded XML or CSV knowledge documents

XML and CSV documents get well-formedness checks only (valid XML / consistent column counts) — not schema validation against a referenced schema, unlike JSON (`$schema`) and YAML/OKF (front-matter). This was explicitly shipped as a v1 limitation with the user's allowance.

Testable: the TODO comments are still present verbatim in both validator files.

## Web client

### `base.css` styles React Aria through its default class names

**Raised by:** phase 02, 003.01 · **Condition to revisit:** a `react-aria-components`
upgrade renames a default class, or deprecates a component the way 1.20
deprecated `Radio`

React Aria ships no styling, so `src/styles/base.css` carries the minimum a
control needs to be usable — a radio indicator, a selected state and a focus
ring — selected by `.react-aria-RadioButton`, `.react-aria-RadioGroup` and
`.react-aria-Button`. Those names are the library's `defaultClassName` values,
a convention rather than a documented API, and the surface is demonstrably
moving: 1.20 deprecates `Radio` in favour of `RadioField` + `RadioButton`, which
this prompt had to adopt mid-implementation.

Two things make the failure quiet. Passing `className` to a React Aria
component **replaces** the default rather than adding to it (`computedClassName
?? defaultClassName`), so a component that sets its own class silently loses
every rule unless it repeats the library's name — `ThemeControl` does. And a
renamed class breaks nothing that any test can see in jsdom: the `data-*`
attributes are still emitted, so only the browser tier's computed-style
assertions would notice. Recorded in the memory `project-react-aria-class-names`.

### The theme storage key is written in three places

**Raised by:** phase 02, 003.01 · **Condition to revisit:** a build step that can inject a
shared constant into the entry document becomes worth its cost

`THEME_STORAGE_KEY` is declared in `src/theme/storage.ts`, duplicated in the
pre-paint script in `index.html` (which must run before the bundle loads and so
cannot import it), and now repeated a third time in
`test/browser/app-shell.spec.ts`, which seeds a theme through `localStorage` and
cannot import from `src/`. The doc comment on the constant names all three; that
comment is the only thing holding them together.

### A component stylesheet with an empty rule body cannot space its own content

**Raised by:** phase 02, 003.01 · **Condition to revisit:** the first theme is written,
which is when the empty rule bodies get filled

ADR-026's convention means `LandingPage.css` and `ThemeControl.css` ship real
class names and no declarations, which is the intended trade. The visible
consequence is that the two radio groups on the landing page sit flush against
each other, with the "Colour mode" label directly beneath the last palette
option — the grouping is unambiguous to a screen reader, which reads the
`radiogroup` name, and merely cramped to a sighted reader.

This is a compromise taken knowingly, not a defect: ADR-020 defers visual design
entirely, and the alternative is putting layout values in `base.css`, where they
would apply to every page and be much harder to undo. Nothing needs doing until
the themes are written.

### `t` has no plural rules, so announcements are phrased around the gap

**Raised by:** phase 02, 003.03 · **Condition to revisit:** the phase 03 i18n library lands and replaces `src/strings.ts`

`t(key, params)` fills `{placeholder}` slots and does nothing else. Every announcement wording is therefore written to read acceptably at any count — `'Tasks: {count} added'`, never `'{count} tasks added'`, which is wrong at one.

That constraint is invisible in the code: a later prompt adding `'{count} enquiries waiting'` gets no warning and produces "1 enquiries waiting" for the most common case. It holds only as long as someone remembers why the existing keys are phrased the way they are, which is why it is written into 007.01 as well. Recorded in the memory `project-strings-no-pluralisation`.

### A channel's throttle interval is fixed by whichever announcement opens its window

**Raised by:** phase 02, 003.03 · **Condition to revisit:** a channel ever gets two writers

`announce({ throttleMs })` is read only when a channel has no open window. A second announcement arriving mid-window joins it and its own `throttleMs` is ignored, so a caller asking for an immediate announcement on a channel that is already accumulating waits for the accumulation instead.

This is correct while a channel belongs to one surface, which is the documented rule and is true of everything built so far. It becomes a real defect the moment two components announce on the same channel with different urgencies — and it fails quietly, as a delay rather than an error. The fix if it happens is a channel per urgency, not a shorter window.

### `useCompanies` is not live

**Raised by:** phase 02, 007.02 · **Condition to revisit:** a view exists that shows more than one company and must reflect a change to any of them without a reload

Every other list hook in `src/api/hooks.ts` patches itself from the company
SSE channel. `useCompanies` cannot: only per-company channels exist, so there
is no stream to patch it from. A list-level stream would have to be built.

It would otherwise patch whichever company the current page happens to be
subscribed to and no other, which is worse than not patching at all, because
it looks like it works. `CompaniesPage` refetches on mount instead, and that
is enough for it.

**Also (phase 02, 006.01: no pagination either):** The company detail page fetches one company; the overview fetches every company a user can see in one request, with no pagination. This is fine while company counts are small. The plan noted that stats are computed in a fixed four queries regardless of company count (ADR-023), so the ceiling is payload size, not server work — but nothing currently limits payload size either.

Testable: create enough companies for one membership and watch the overview's network request grow with them.

### The waiting line comes from the agent's status, not from the transcript

**Raised by:** phase 02, 008.02 · **Condition to revisit:** the line is seen to blink off between the two signals during `001.01` (phase 06)'s browser pass

`MessageInput` shows "waiting" while `send.isPending` or the agent's live status is `running`. The backend sets `running` and records the `state_change` before it answers the send with `202`, so in practice the two signals overlap — but they are two different things, arriving by two different paths (a settled fetch and an SSE event), and nothing in the code guarantees which lands first at the client.

Testable: watch the waiting line through a real send in a real browser. If it drops for even a frame between the request settling and the `state_change` event arriving — or the other way round — that is the trigger, and it needs `MessageInput` to read a combined signal deliberately rather than relying on the two overlapping by luck.

### The task dialog cannot be parked, and the dock features built for it are unused

**Raised by:** phase 02, 008.03 · **Condition to revisit:** a user is seen wanting to keep a long-running task open while working elsewhere in the application

008.02 added three things to the dock partly with a future task dialog in mind: `DockEntry.label` as a `ReactNode` (so a parked entry can show live state), `dock.remove(id)` (drop an entry without reopening it) and `dock.focusEntry(id)` (move focus to a dock button directly). 008.03 chose a plain modal instead — one task at a time, closed by its Close button or Escape — because a task dialog holds nothing the user has authored, unlike a chat's half-typed message. All three dock features remain correct and tested; they are exercised only by the chat dialog today.

Testable: a user is observed wanting to watch a task progress while doing something else in the application, rather than leaving the tab open and idle. If that happens, the fix is a `TaskProvider` beside `ChatProvider` in `AppShell`, following the shape 008.02 already built — not a redesign of the dock.

### A new assignment appearing on an open task is not announced

**Raised by:** phase 02, 008.03 · **Condition to revisit:** a user reports missing that the planner fanned a task out into new work while its dialog was open

`TaskDialog` announces a status _change_ on an assignment already seen, seeded silently on the first render so opening the dialog is not read out as several changes at once. An assignment appearing for the first time is recorded into that seed silently too, by the same mechanism — deliberately, since the two paths share one effect and telling them apart would mean tracking which ids were "already there" separately from which ids exist. `useListChangeAnnouncement` (003.03) is the existing hook that announces list membership changes and would do this, but it expects one channel per list; sharing `` `task:${taskId}` `` with the status-change announcements would violate the announcer's one-writer-per-channel rule, so it would need a channel of its own.

Testable: a task is open, the planner adds an assignment to it, and nothing is said. If that is judged worth announcing, add a second channel — do not widen the existing one.

### The task's materials, expected outputs and completed outputs are not shown

**Raised by:** phase 02, 008.03 · **Condition to revisit:** the generated schema stops typing `materials`, `expected` and `completed` as `Record<string, never>[]`

`TaskDetailResponseDto` and `AssignmentResponseDto` both carry these fields, but the Swagger plugin never described the artifact union backing them, so the generated client types each as an array of empty objects. Nothing can be read out of one without an `any` cast, so the task dialog shows only the request, the status and the failure reason. See the existing entry on the generated schema documenting the persistence shape rather than the wire shape, above.

Testable: `npm run api:generate` produces a real type for `materials`/`expected`/`completed` instead of `Record<string, never>[]`. When it does, the task dialog is the first place worth rendering them.

### A closed enquiry keeps its row in the cached list, and every reader has to re-filter

**Raised by:** phase 02, 008.04 · **Condition to revisit:** `applyEvent` learns to remove a row from a cached list

`applyEvent` (`src/events/cache.ts`) patches a cached list row in place when an event's `summary` matches an id it already holds. Every backend publisher of an `enquiry` state change — `conversation.controller.ts`, `pause-and-resume.service.ts`, `company-priming.service.ts` — sends a `summary` carrying the same id. So when an enquiry is answered, the cached `awaiting_user` list gets its `status` updated to `closed` and **keeps the row**; the invalidate-and-refetch path that would have dropped it is skipped precisely because the patch succeeded.

The query's `status=awaiting_user` filter therefore only describes what was true when it was fetched. `EnquiriesList` already knew this and re-filters client-side. `NewEnquiryNotifications` did not, and shipped in this prompt with a comment claiming it dropped notifications for enquiries that had left the list while doing nothing of the sort — a stale notification for a question someone else had already answered would sit there until dismissed by hand. Found by writing the test, fixed with the same client-side filter, and covered by a test that fails without it.

The general shape is the problem: this is the second reader of that list, and the second to need the same guard. A third will need it too, and nothing warns them.

Testable: `applyEvent` drops a row whose patched status leaves the filter its list was fetched under. Until then, **every** reader of a status-filtered live list must re-filter, and the two that do should be the examples a third copies.

**Also (phase 02, 008.04):** `Notification` always announces, immediately, on whichever channel it is given. Rendering one for a new enquiry on the `enquiry` channel while `EnquiriesList` still called `useListChangeAnnouncement` on that same channel produced two announcements for one arrival, coalesced by the announcer into a single phrase that said the same thing twice. One writer per channel is the convention, so the notification became that writer and the list's call was removed.

The cost is the `removed` half of what that call did: nobody is now told when an enquiry leaves the awaiting list because someone else answered it. That is background noise rather than a request to act, and the list's item count and `aria-busy` still change — but it is a real loss, taken knowingly rather than overlooked.

Testable: a user answers an enquiry in `tcp-cli` while another has the activity view open, and the second user is not told the question is gone. If that reads badly in 001.02 (phase 06), the fix is a second channel for departures, not restoring the doubled announcement on the shared one.

### The client reads soft warnings that no task route ever sends

**Raised by:** phase 02, 008.04 · **Condition to revisit:** a `computeTaskWarnings` appears, or a data-quality check for tasks is asked for

The creation dialog surfaces `X-Tcp-Warnings` from the create response, because the prompt asked for soft warnings to be shown rather than dropped. On the server, `setWarningsHeader` is called only by `api.company.controller.ts`, `api.role.controller.ts` and `knowledge.controller.ts` — **never by `task.controller.ts`**. So the path is real, tested against a mocked header, and dead in production.

It was built anyway rather than left out: the reading costs a few lines, and a warning the server starts sending would otherwise be silently dropped by a client that never looked. No backend change was made to start sending task warnings — what is worth warning about on a task is a data-quality decision, not this prompt's.

Testable: `grep -rn setWarningsHeader apps/backend/apps/tcp-server/src/api/task.controller.ts` returns a hit. Until then the dialog's warnings panel is unreachable in a real deployment.

### A task whose files failed to upload cannot be retried from the UI

**Raised by:** phase 02, 008.04 · **Condition to revisit:** uploads fail often enough for someone to notice

Creating a task with attachments is three ordered calls: create, upload each file, then start. The server refuses a material once the task has left `ready`, so the uploads must land before the start. When one fails, `useCreateTask` does not throw and does not start the task — the task exists in `ready` with some of its files, and the dialog names the ones that did not attach.

There is no retry. Offering one means plumbing the created task's id back through a form that has already succeeded at its main job, and the recovery path that exists — `tcp-cli`, or `PUT /api/task/{id}` while it is still `ready` — is not discoverable from the dialog. The alternative considered and rejected was failing the whole creation, which would be a lie: the task is really there.

Testable: someone hits this and has to ask what to do. The fix then is a retry on the dialog's failure panel, not a change to the ordering.

### An empty profile dialog is a configuration state, and nothing will prompt anyone to check it

**Raised by:** phase 02, 008.04 (carrying 004.01) · **Condition to revisit:** an identity provider other than Zitadel is put in front of this application

The profile dialog reads `name`, `email` and `sub` from the ID token's claims through `getUserManager()`'s stored user — there is deliberately no `/api/me` (ADR-023). Whether the client also calls the provider's userinfo endpoint is the runtime setting `OIDC_LOAD_USER_INFO`, `false` by default because Zitadel puts `profile` and `email` in the ID token.

A provider that returns a minimal ID token therefore produces a dialog with two "not provided by your sign-in provider" rows and an account identifier. That is a variable nobody set, not a bug in the dialog — so the dialog says so in its own text, naming the setting. Changing it needs no rebuild.

This one **also has a memory**, because it is conditional on a provider swap that nothing in this repository will ever raise.

Testable: `OIDC_LOAD_USER_INFO=false` against a provider whose ID token omits `profile`/`email` shows the fallback. Setting it to `true` fills the dialog without a rebuild.

### Nothing in the task dialog shows a date, and the second surface has now arrived

**Raised by:** phase 02, 008.03 · **Updated by:** 008.04 · **Condition to revisit:** now met — a third surface needs a timestamp, or the response dialog's formatter is copied once

The task and its assignments both carry `createdAt`/`updatedAt`, but there is no date formatter anywhere in the web client and `t()` has no date handling — so the task dialog omits them rather than rendering a raw ISO-8601 string.

008.03 said the trigger was "a second surface needs a formatted date". **That has happened.** The response dialog renders each message's timestamp, and it does so in the _company's_ timezone rather than the browser's — `ConversationDetailResponseDto` carries `companyTimezone`, and using the browser's zone would misreport when an agent asked its question. It has its own local `formatTime` in `ResponseDialog.tsx`, which is now the only date formatting in the application.

So the shared formatter is genuinely owed and was not built here: extracting it correctly means deciding whose timezone each surface uses, and only one surface has an answer so far. The honest state is one local formatter with a known home to move to, not a shared one nobody has designed.

Testable: a third surface needs a timestamp, or someone copies `formatTime` out of `ResponseDialog.tsx`. Either is the moment to extract it — and the extraction has to carry the timezone question, not just the formatting.

### An invalid company timezone silently falls back to the browser's

**Raised by:** phase 02, 008.04 · **Condition to revisit:** a company can set its timezone through the UI

`Intl.DateTimeFormat` throws `RangeError` on a timezone string it does not recognise, and a throw while rendering the conversation would blank the whole dialog over a formatting detail. So `formatTime` catches it and re-formats in the browser's zone instead.

That is the right trade for reading a conversation, but it is silent: a company with a misconfigured timezone shows plausible times in the wrong zone, and nothing says so. Nothing validates `timezone` on the way in either — `companyTimezone` is a free string on the company record.

Testable: the company configuration view (002.01, phase 06) lets someone type a timezone. Validate it there, where the mistake is made and can be reported, rather than at every surface that reads it.

### The Chats list has no concept of "my chats"

**Raised by:** phase 03, 002.02 · **Condition to revisit:** a user asks to see only chats they started

`ChatsList` (the Chats tab) shows every chat in the company, filterable
by status and role, because the backend records no chat owner — a
chat-mode assignment carries no `createdBy`/`userId` field to filter on.
This matches how every other activity list works today (company-wide, not
per-viewer), so it wasn't treated as a gap to close in 002.02.

Testable: a user with several colleagues in the same company asks to filter
the Chats list down to just their own.

### `LandingPage`'s location-state sign-in path has no producer

**Raised by:** phase 02, 004.03 · **Condition to revisit:** anything else starts navigating to `/` with location state, or someone next edits `LandingPage.tsx` for an unrelated reason

Once `RequireSession` stopped routing through `/` with `{ from }` state (004.03), nothing navigates to the landing page with state any more. The `useLocation().state → startSignIn(state)` branch in `LandingPage.tsx` is dead code that still compiles and still passes its tests. The 004.03 plan recorded it as "worth deleting the day something else touches that page" and left it alone rather than touching two files for no behaviour change.

Testable: `grep -n "useLocation" apps/frontend/tcp-frontend/src/pages/LandingPage/LandingPage.tsx` still shows the read, and nothing in the route table passes it state.

## Office view

### Unbounded lists

**Raised by:** phase 03, 000.01 · **Condition to revisit:** the agent, task or assignment list endpoints gain pagination or status filters, or a company's history makes the page visibly slow

`useOfficeWorld` fetches every agent, task and assignment the company has ever
had — the list endpoints return every row ever, not just the active ones —
and `buildCompanySnapshot` scans all of them on every change. This matches
how the activity view already works, and is fine while a company's history is
small.

Testable: open the office view on a company with a long history and watch
whether it becomes visibly slow to update.

### A desk added under a standing avatar

**Raised by:** phase 03, 000.01 · **Condition to revisit:** real furniture art makes it noticeable

A new desk can be added to a task room at a tile a role avatar's placeholder
shape already occupies, if that avatar happens to be standing there. It stays
drawn inside the desk until it next moves. Cosmetic only, and invisible with
today's placeholder shapes.

Testable: real sprite art for desks and avatars exists, and the overlap is
now visible.

### Canvas labels aren't laid out

**Raised by:** phase 03, 002.01 · **Condition to revisit:** labels in a busy room become unreadable in ordinary use

`scene/LabelLayer.ts` puts each label above its anchor and does nothing when
two overlap. A task room with several avatars at neighbouring desks, with
Agents and Furniture both on, will stack labels on top of each other. Since
005.01 an agent label can also overlap its own thought bubble's cloud. Marked
`ponytail:` in the file; the upgrade is nudging overlapping labels apart, or
showing furniture labels only on hover.

Testable: turn on every label in a task room with three or more avatars and
read them.

### The archive's "finishing agent" is a recency rule, not the true finisher

**Raised by:** phase 03, 002.02 · **Condition to revisit:** the wrong avatar is visibly seen carrying a task's outputs

The avatar that carries a succeeded task's outputs to the bookshelf is
whichever avatar in the room most recently dissociated from the task
(tracked by a world-wide sequence counter), falling back to one that still
holds a live agent if none has left yet. This is a deliberate proxy, not the
"true" finishing agent by assignment order — a QA reviewer who leaves last
would carry outputs from work an earlier implementer actually finished. It
reads correctly in the ordinary case (the last avatar in the room really did
just finish something), and was accepted as good enough rather than plumbing
through which assignment closed the task.

Testable: watch which avatar picks up the box on a task with several
avatars, and check whether it's the one that actually completed the
task-closing assignment.

### The "Add new" button is hidden in full screen

**Raised by:** phase 03, 003.01 · **Condition to revisit:** a user in the office view's full-screen mode wants to create a task

Full screen shows only the office view's own section, so the page's floating
"Add new" button isn't in it. Starting a chat is still possible there from a
role's tray ("Chat with {role}"). Creating a task is not.

Testable: enter full screen on the office view and look for a way to create a
task without leaving it.

**Also (phase 03, 003.01: the button and a wrapping dock):** The floating "Add new" button is lifted clear of the dock by a fixed `--tcp-dock-block-size` sized for one row. If enough chats/tasks are docked at once that the dock wraps to a second row, the button would overlap it. Nothing currently causes the dock to wrap, so it hasn't been seen.

Testable: open enough chat/task dialogs and minimise them until the dock would need to wrap, and check whether the floating button is obscured.

### The office view's tray has no exit animation

**Raised by:** phase 03, 005.01 · **Condition to revisit:** a user asks for the tray to slide out as well as in

The tray slides in over the canvas with `@starting-style`, but it unmounts on
close, so it vanishes rather than sliding out. Marked `ponytail:` in
`CompanyVisualisation.css`; the upgrade is keeping it mounted in a closing
state until its transition ends.

Testable: open and close the tray, and watch whether it slides out.

### Office view motion shortcuts

**Raised by:** phase 03, 000.01 · **Condition to revisit:** each bullet has its own

Five deliberate shortcuts, each marked `ponytail:` in the office view's code and never recorded until now. Each is fine at today's sizes and frame rates.

- **A\* keeps its open list as a sorted array.** Fine at today's map sizes. Needs a binary heap once the tile grid passes roughly 2,000 tiles.
- **Blocked avatars ghost through.** After 4 seconds blocked, an avatar walks through others instead of waiting forever. It's a deadlock escape, not collision avoidance. Revisit when walking through another avatar looks wrong in ordinary use; the fix is priority-based yielding.
- **A walker's leftover step distance is dropped each frame.** Invisible at normal frame rates. At low frame rates, walking looks slower than `WALK_TILES_PER_SECOND`.
- **A long frame is capped at 100 ms.** After a backgrounded tab returns, avatars pause rather than teleport. Revisit if they visibly snap or skip.
- **Full-screen refusals are swallowed.** If the browser refuses `requestFullscreen()` or `exitFullscreen()`, `useFullscreen` does nothing and says nothing. Revisit when a user reports being stuck in, or unable to enter, full screen.

Testable: grep `ponytail:` under `apps/frontend/tcp-frontend/src/visualisation/` for each.

## CLI, TUI and setup

### Set-embedding-model script never built

**Raised by:** phase 01, 010.07 · **Condition to revisit:** Someone needs to change the embedding model after initial setup and hits the "manual migration + reindex" friction described in `docs/index.md`

Phase 6 of the 010.07.01 configuration plan ("Set Embedding Model Script") was never started — all its units stayed "Not started" and a later side-mission plan (010.07.04) only updated the parent plan's text, it didn't build the script. ADR-018's decision section fully specifies the intended flow (prompt for new model, probe dimension, offer to run the migration and re-index). Today, changing the embedding model means hand-editing `.env` and running a migration/reindex manually.

Testable: grep `scripts/` and `package.json` for `set-embedding-model` — there is nothing.

### Persisted default-company CLI context never built

**Raised by:** phase 01, 010.01 · **Condition to revisit:** Users repeatedly complain about having to pass `--company` on every command when they only work with one company at a time

Twice during phase 01, a plan found that `tcp-cli` has no way to remember "my usual company" between commands — every command needs `--company`/`--role` explicitly, or it errors immediately. Both times it was explicitly ruled out of scope rather than built.

Testable: run any `tcp-cli` command with only `--role` as a slug and no `--company` — it errors rather than falling back to a remembered default.

### The TUI seeds active agents only, so a finished agent's task pane starts blank

**Raised by:** phase 03, 002.02 · **Condition to revisit:** a task pane shows a blank agent status for an assignment with a live (non-terminal) agent

The TUI's task panel seeds each assignment's `[agent: …]` label from
`GET /api/agent?companyId=`, which lists active agents only — an agent whose
assignment is already `succeeded`/`failed`/`cancelled` isn't in that list,
so its pane opens with no agent label. This wasn't treated as a gap: the
assignment's own status already shows the outcome, and every state after
that point is covered live from the company's SSE stream. The condition
above is deliberately narrower than "any finished agent" — it only needs
revisiting if a pane ever shows blank for an agent that's actually still
running, which seeding-from-the-active-list would not explain.

Testable: open a task pane for an assignment whose agent is currently
`running`, `paused` or `in-qa` and check the `[agent: …]` label is never
blank.

### Setup wizard follow-ups

**Raised by:** phase 03, 004.01 · **Condition to revisit:** each bullet has its own

The 004.01 plan listed three setup improvements under "Other setup UX opportunities" and left them unowned.

- **A model picker.** The wizard's LLM step takes a typed model id. Listing `/models` from the chosen provider would be a small follow-up, since the catalogue and probe code exist. Revisit when a user asks to pick from a live list, or the static catalogue goes stale.
- **`tcp-cli.sh` hardcodes `-p tcp-dev`.** `start-dev.sh` and `stop-dev.sh` take `--project`, so named stacks can coexist. `tcp-cli.sh`'s Docker sync and drain-on-shutdown still always target `tcp-dev`, so they act on the wrong stack for any other instance name. Revisit when someone runs a second named instance.
- **The wizard doesn't offer sample companies.** `start-dev.sh --seed` now adds the test companies without a reset, but the wizard never offers it. Revisit when a new user finishes the wizard with nothing to look at.

Testable: run the wizard on a new instance with a name other than `tcp-dev`, then run `tcp-cli.sh shutdown` against it.

### A trusted certificate needs a manual compose override

**Raised by:** phase 02, 002.03 · **Condition to revisit:** first-run friction is reported

`tcp-web` generates a self-signed certificate at startup, so a first run needs no
setup, at the cost of a browser warning. [mkcert](../web-client.md#a-trusted-certificate-with-mkcert)
removes the warning, but wiring it in means the reader adding a `volumes:` entry
by hand — the one step in that guide that isn't copy-and-paste.

It was left manual deliberately: a committed bind mount pointing at a directory
most people won't have is its own failure mode. If the warning turns out to bite
often enough, the answer is probably a `docker-compose.local-certs.yml` overlay
and a `--certs` flag, matching `--dev-ports` and `--dev-web`.

### Dead CLI log-format helpers left behind by the 008.01 transcript refactor

**Raised by:** phase 02, 008.01 · **Condition to revisit:** someone next touches `agent-log-format.ts` or does a dead-code sweep of `tcp-cli`

When the transcript renderers moved to `libs/tcp-shared/src/transcript/` in 008.01, only three helpers moved with them. Four others were left behind in the CLI's own `agent-log-format.ts` because nothing else in that file needed to move, but they'd already lost their only caller. The plan flagged them as "worth a sweep" and then nobody swept them.

Testable: `grep -rn "shortId\|JsonDeltaFormatter\|LogHeadingTracker" apps/backend/apps/tcp-cli/src` matches only the definition file and its spec.

## Tests and tooling

### stub-LLM e2e through the real agent loop

**Raised by:** phase 01, 010.01 · **Condition to revisit:** The stub-LLM gains the ability to emit a deterministic multi-agent tool-call sequence (`create_plan`→`complete_assignment`→`assure_assignment`), which it couldn't do as an HTTP service when this was written

End-to-end orchestration tests drive tcp-server's internal endpoints directly rather than going through a real multi-agent LLM loop, because no HTTP LLM stub exists that can emit the right sequence of tool calls per step. The no-LLM integration suite is accepted as the load-bearing coverage instead.

Testable: `test/e2e/tcp-server/task-orchestration.e2e-spec.ts` drives internal endpoints, not a live agent loop against stub-llm.

### Moving Docker test setup into Jest globalSetup/globalTeardown

**Raised by:** phase 01, 011.01 · **Condition to revisit:** The user asks for it explicitly

The idea is to replace the shell-script Docker Compose setup/teardown around the test tiers with Jest's own `globalSetup`/`globalTeardown` hooks. It's a legitimate simplification but the user has twice said not to start it unprompted.

Testable: `test/integration/global-setup.ts` and `scripts/run-integration-tests.sh` still show the shell-script-driven pattern.

### Mid-run Redis resilience and testcontainers reuse mode

**Raised by:** phase 01, 009.03 · **Condition to revisit:** A circuit-breaker/degraded-mode design becomes necessary (e.g. Redis drops mid-run in production, not just at startup), or local iteration speed on testcontainers becomes a real pain point

009.03.01 fixed hangs when Redis is unreachable at startup, but deliberately left alone what happens if Redis drops after a successful connection — a materially bigger circuit-breaker/degraded-mode question. It's still undecided today, five phases later.

Testable: `docs/index.md`'s ADR-016 row still names both gaps; no later ADR or plan addresses mid-run Redis loss.

### Most e2e specs still clean up by emptying shared tables

**Raised by:** phase 02, 006.01 · **Condition to revisit:** a spec fails on data it did
not create, or the tier's failure rate rises above zero again. Testable:
`grep -rc 'createQueryBuilder().delete().execute()' apps/backend/test/e2e/`
returns hits in more than a couple of files.

Every spec in the e2e tier shares one Postgres database, migrated once by
`global-setup.ts` and never reset between spec files, so each spec is
responsible for its own rows. About fourteen of them discharge that
responsibility with `repo.createQueryBuilder().delete().execute()` — no `WHERE`
clause — which removes every row in the table rather than the ones that spec
created. `system-shutdown.e2e-spec.ts` was rescoped to its own `companyId` in
006.01, because its four unqualified deletes over the audit table made it the
slowest hook in the tier; the rest were left alone.

Under `maxWorkers: 1` this is usually harmless, because files run one at a
time. What it leaves is no margin: the moment any spec has an async write still
in flight past its own teardown — a BullMQ job, a fire-and-forget audit post —
the next spec's first blanket delete removes it, and the symptom lands in a file
that did nothing wrong. Two specs also collide on genuinely global unique
constraints: `tcp_company.slug` is hardcoded `'acme'` in both
`agent.e2e-spec.ts` and `company-role.e2e-spec.ts`, and `Conversation.slug` is
derived from a role name, so the role `analyst`/`Analyst` in
`internal-conversation.e2e-spec.ts` and `task-company-events.e2e-spec.ts` both
produce `analyst-1`.

None of this was observed firing — the tier's actual flake had a different and
now-fixed cause (see the memory `project-e2e-jwt-flake`: supertest was binding a
fresh ephemeral port per request, colliding with Docker's dynamic container port
mappings, so requests were occasionally answered by a container). Scoping the
remaining deletes and namespacing the two slugs is a tidy-up worth doing on its
own merits, not a fix for a known failure, which is why it was not bundled into
006.01.

### Backend typecheck has no guard for the `libs/tcp-shared` `import type` rule

**Raised by:** phase 02, 008.01 · **Condition to revisit:** a type-only import added to `libs/tcp-shared` from the backend side passes `tsc` locally but fails the frontend build or the pre-commit hook

Code shared into `libs/tcp-shared` needs `import type` for every type-only import, or it compiles for the backend workspace and fails for the frontend's stricter one. The 008.01 plan hit this and noted the pre-commit hook caught it while "the CLI's own typecheck did not" — i.e. a backend-only contributor can pass their own `npm run typecheck` and still ship a broken frontend build, catchable only by the pre-commit hook or CI.

Testable: add a missing `import type` to a type moved through `libs/tcp-shared`, run the backend's typecheck alone, and see whether it's clean.

### The generated-client drift check still only runs after the full deployment bake

**Raised by:** phase 02, 005.01 · **Condition to revisit:** the ~6 minute lag between pushing a controller change and finding out the committed `schema.d.ts` is stale becomes a real irritant

Checking whether the committed `apps/frontend/tcp-frontend/src/api/schema.d.ts` matches the backend's OpenAPI description needs a running server today, so the feedback only arrives after the whole `api-test` deployment has booted. The plan noted a cheaper partial check — comparing types against a committed description with no live server — could be added later "without undoing anything here," but nobody has.

Testable: time how long after a controller change the drift failure is reported in CI.

### No compiler link between the nginx init script's heredoc and `RuntimeConfig`

**Raised by:** phase 02, 004.01 · **Condition to revisit:** a new `RuntimeConfig` field is added and the shell script isn't updated to match, or vice versa

The browser's runtime configuration is assembled by a bash heredoc in the nginx entrypoint and consumed through a hand-written TypeScript interface. Nothing checks that the two agree — they're a shell script and a type that match by convention only. The plan noted a concrete failure mode: a quoted `'false'` satisfies the interface's type but is truthy at runtime, so three separate pieces of code (the shell's normalisation, the client's `=== true` comparison, and a browser-tier test) each individually guard against it, instead of one compiler doing it once.

Testable: add a field to `RuntimeConfig` without touching `10-tcp-init.sh`, and see that nothing in the type system or the lint/typecheck gate catches the mismatch.

### `hosting.spec.ts` fails under `--dev-web`

**Raised by:** phase 03, 000.01 · **Condition to revisit:** none — standing note

`hosting.spec.ts` only holds for a built bundle, so it fails when the
deployment is started with `--dev-web` (Vite serving the frontend directly).
This is not a regression from 000.01; it is a standing fact for anyone running
the browser tier this way. The full browser tier must run against a built
deployment.

## Upstream dependencies

### Deferred dependency bumps (TypeScript 7, better-sqlite3 13)

**Raised by:** phase 01, 011.01 · **Condition to revisit:** TypeScript 7 bump wakes when `ts-jest` supports TS 7 (its peer range is `>=4.3 <7`); better-sqlite3 13 wakes when the CI/Docker build image gains a Python toolchain for node-gyp

Both bumps were deliberately slept via `@dependabot ignore this major version` rather than fixed, because each is blocked by something outside this repo's control. Nothing has changed on either blocker since.

Testable: check `apps/backend/package.json` versions and whether a `dependabot` PR for either exists and is open.

### HTTP/2 in development depends on two upstream gaps

**Raised by:** phase 02, 002.03 · **Condition to revisit:** either gap closes

The `--dev-web` overlay exists only because of two things neither of which is
ours:

- **Vite's development server has no HTTP/2.** If it gains one, the overlay
  becomes optional for anyone who doesn't also want the same-origin `/api`.
- **nginx does not implement RFC 8441** (WebSockets over HTTP/2), so the HMR
  socket rides a separate HTTP/1.1 connection. It works, via a browser
  fallback, but it means a browser that ever drops that fallback breaks HMR
  through the proxy.

Both are recorded in the memory `project-web-http2-upstream-gaps`, because
nothing in this repository will surface them on its own.

### `@react-aria/live-announcer` is a one-line shim over a `private` subpath

**Raised by:** phase 02, 003.03 · **Condition to revisit:** the shim stops publishing alongside `react-aria`, or `announce` becomes a public export of `react-aria` or `react-aria-components`

[ADR-026](../ADRs/ADR-026-web-ui-accessibility-and-component-library.md) chose React Aria partly for its live announcer, which is real but not reachable the obvious way: `announce` is absent from `react-aria-components`' index, and that package's exports map contains `"./private/*": null`, deliberately blocking the subpath the function lives at. The application therefore depends on the sibling package `@react-aria/live-announcer`, whose entire published source is `export { announce, clearAnnouncer, destroyAnnouncer } from 'react-aria/private/live-announcer/LiveAnnouncer'`.

This is the least-bad of three options — the alternatives were importing the `private` path directly as a phantom dependency, or hand-rolling two live regions and giving up Adobe's assistive-technology testing. It is fine while Adobe keeps publishing the shim in step with `react-aria`. It stops being fine silently: nothing breaks at install time if the shim is abandoned at an older major, it just quietly stops receiving fixes.

Testable as `npm view @react-aria/live-announcer version` lagging `react-aria`'s major, or as `announce` appearing in `react-aria-components`' index types. Recorded in the memory `project-react-aria-live-announcer-shim`.

### `openapi-fetch` is a `0.x` dependency under the application's whole data layer

**Raised by:** phase 02, 005.01 · **Condition to revisit:** the package reaches 1.0, or a minor release breaks the build

Reasoning: chosen over hand-written conditional types because those are where the "no `any` at the boundary" rule breaks in practice — openapi-fetch is by openapi-typescript's author, in the same repository, MIT, one transitive dependency, and its middleware hook is where the shared 401 policy goes. Pre-1.0 means a minor version may break. The exposure is bounded: one import in `src/api/client.ts` plus the type plumbing in `src/api/queries.ts`, and the fallback — hand-written generics over the same generated `paths` type — stays available.

### `eslint-plugin-jsx-a11y`'s peer-dependency pin has no recorded recheck condition

**Raised by:** phase 02, 002.01 · **Condition to revisit:** `eslint-plugin-jsx-a11y` ships a release that declares compatibility with eslint 10, at which point the override can be removed

`eslint-plugin-jsx-a11y` 6.10.2 declares a peer on eslint 9, which otherwise makes npm install a second, nested eslint that crashes on this repo's `brace-expansion` override and breaks `npm ci` from a clean tree. The fix was a root `overrides` entry pinning the peer — a working but permanent-feeling patch with no written trigger to remove it, beyond what's informally known.

Testable: `npm view eslint-plugin-jsx-a11y peerDependencies.eslint` reports a range that includes 10.

### Overlays use a deprecated portal prop

**Raised by:** phase 03, 002.01 · **Condition to revisit:** react-aria-components exports `UNSAFE_PortalProvider`, or drops `UNSTABLE_portalContainer`

The office view's toolbar tooltips and the picker's popover portal into the
view's own section through `UNSTABLE_portalContainer` (deprecated), so they
show in full screen and stay inside the page's landmarks. Its replacement,
`UNSAFE_PortalProvider`, lives in `react-aria`, which react-aria-components
pins at an exact version and doesn't re-export; importing it directly would
need a second dependency kept in lock-step, which fails silently when the
two drift. The deprecated prop fails loudly — a type error — if it is ever
removed. Both uses carry an `eslint-disable` for `no-deprecated` that points
here.

Testable: `grep -c UNSAFE_PortalProvider node_modules/react-aria-components/dist/types/exports/index.d.ts`
prints more than 0.

### Silo's console link format was confirmed against one image tag

**Raised by:** phase 03, 002.02 · **Condition to revisit:** the `pgsty/silo` image is bumped, or an archive link ever lands on the bucket root instead of the task's folder

The archive tray's Silo links use `{consoleUrl}/browser/{bucket}/{encodeURIComponent(prefix)}`
— percent-encoded, not MinIO's classic base64-encoded console format. This
was confirmed by hand against a running `pgsty/silo` container on
2026-09-28: a base64 prefix left the browser on the bucket root, reading the
encoded string as a literal folder name, while the percent-encoded form
round-tripped correctly. Nothing pins the image tag this was checked
against, so a future Silo release could silently change the format again.
See [shared-storage.md](../shared-storage.md#links-from-the-web-clients-archive-tray).

Testable: click an archive tray link after a Silo image bump, and check it
opens the task's `completed/` folder rather than the bucket root.
