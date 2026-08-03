# ADR-023: Backend API Surface for the Web UI

**Status:** Accepted (2026-08-03)

## Context

The MVP described in [ADR-020](ADR-020-web-ui-mvp-scope.md) cannot be built against tcp-server as it stands.

The API was built for `tcp-cli` — a trusted client, run by an operator who already knows which company they mean. A browser is a different kind of consumer:

- it runs on a different address to the API
- it has to discover what the signed-in user is allowed to see
- it shows four live lists on one screen

This ADR decides the API changes needed. It does **not** decide the permission model — that belongs to [ADR-011](ADR-011-authentication-authorization.md), whose deferred authorization work is now coming due and is recorded as an amendment there.

## What needs deciding

Six gaps. Each is individually small, but together they decide whether four MVP surfaces can exist at all.

| #   | Gap                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | **CORS.** tcp-server never calls `app.enableCors()`, so no browser can call it                                   |
| 2   | **Membership scoping.** `GET /api/company` returns _every_ company, with no way to ask for just the caller's own |
| 3   | **Identity.** There is no `/api/me`, so the profile dialog has no source                                         |
| 4   | **Consultations.** `PendingConsultation` has no controller, so they can't be listed                              |
| 5   | **Live coverage.** The company event channel carries only company and task rows                                  |
| 6   | **Company stats.** "A few live stats per company" has no endpoint and no definition                              |

They are collected in one ADR because a gap with no owner is a gap discovered late. CORS in particular is nobody's feature and everybody's blocker.

## Options considered

| #   | Chosen                                                                                                                                                  | Alternative                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | Same-origin reverse proxy — CORS never arises                                                                                                           | `enableCors()` with a per-environment allowlist                                                           |
| 2   | `GET /api/company` scoped to membership by default, with an `?all=true` escape hatch — see [scoped by default](#scoped-by-default-with-an-escape-hatch) | `?mine=true` as an opt-in filter (unscoped default), `GET /api/me/companies`, or filtering in the browser |
| 3   | Read the ID token's claims in the browser                                                                                                               | Add `GET /api/me`                                                                                         |
| 4   | Reuse the orphan-assignment query                                                                                                                       | Build a consultations endpoint                                                                            |
| 5   | Widen the company channel                                                                                                                               | Poll the three lists that don't stream                                                                    |
| 6   | A fixed stat set, computed server-side                                                                                                                  | An open-ended stat block, computed per company                                                            |

## Decision

**All six are in scope for phase 02. Four are backend changes; two need no server work at all.**

| #   | Decision                                                                                                                                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Same-origin reverse proxy** ([ADR-029](ADR-029-spa-hosting-and-runtime-configuration.md)), so CORS isn't needed. `enableCors()` stays documented as the fallback                                                                                                                                    |
| 2   | **`GET /api/company` returns the caller's own companies by default**, matching on `sub` **or** `email` — see [membership matching](#membership-matching-must-accept-both-identifier-forms). **`?all=true` asks for every company** — see [scoped by default](#scoped-by-default-with-an-escape-hatch) |
| 3   | **ID token claims, read in the browser.** No `/api/me` in the MVP                                                                                                                                                                                                                                     |
| 4   | **Reuse the orphan-assignment query.** A proper endpoint is deferred — see [consultations](#consultations-are-an-approximation)                                                                                                                                                                       |
| 5   | **Widen the company channel** to carry agent and assignment rows — see [live coverage](#widening-the-company-channel)                                                                                                                                                                                 |
| 6   | **A fixed, cheap stat set** returned with the scoped response — see [stats](#the-stat-set-is-fixed-now-deliberately)                                                                                                                                                                                  |

Deliberately **not** done: no `/api/me`, and no consultations controller. Both are real gaps; neither blocks the MVP. Adding them now would be building for a release that hasn't been specified.

## Consequences

- Four changes land in tcp-server: the scoped-by-default company list with its stat set, the event-channel widening, the extended priming, and the fallback CORS configuration. Only the first two are visible to a user.
- **The consultations list is an approximation.** It shows consultee _assignments_, not pending consultations, so a consultation still waiting to be picked up doesn't appear. The UI must not imply the list is complete.
- Company event traffic increases — every agent state change now reaches every subscriber of that company's stream. Fine at current scale, and the first thing to look at if the live view gets noisy.
- **`tcp-cli list-companies` and the existing API tests must be updated to pass `?all=true`.** Flipping the default is the point, but it means today's "list everything" caller silently sees a scoped list unless it opts back in — a real behaviour change, not just an addition. See [migrating existing callers](#migrating-existing-callers).
- `?all=true` carries no enforcement in the MVP — anyone with a valid token can still see every company, exactly as today. What changes is that this is now a named, explicit request rather than the silent default, which is exactly the seam the ADR-011 amendment gates once permission groups exist.
- Reading identity from token claims ties the profile dialog to the identity provider's claim set. Zitadel supplies `sub`, `name` and `email`; a provider that didn't would need `/api/me` after all.
- No database migration. All six are query, routing or configuration changes — the entities already have the columns needed.

## Alternatives considered

- **`?mine=true` as an opt-in filter, unscoped by default.** The original design here. Rejected in favour of scoping by default: it left the endpoint insecure by default and secure only if the caller remembered to ask, which is the wrong way round for something a public browser client now calls.
- **A separate path** (`GET /api/company/all`) instead of a query flag. Cleaner REST separation of "list mine" from "list everything" — and rejected only because it doesn't match the existing convention of boolean query flags elsewhere in this API (`?force=` on shutdown), for no clear gain: the CLI has to change either way.
- **Filtering companies in the browser.** No backend change, and it sends every company name in the system to every signed-in browser, then makes one request per company to check membership. Rejected on both exposure and request count.
- **A full `/api/me` with a server-held profile.** Rejected as speculative — nothing in the MVP writes profile data, and the token already carries what the dialog shows.
- **Polling the three non-streaming lists.** Simpler, and rejected because it makes the flagship surface three-quarters not-live, to avoid a two-line change.
- **A single `/api/company/:id/activity` endpoint** returning all four lists at once. Attractive for the first render, and rejected as a second source of truth: the event stream already carries these entities, so the endpoint would have to agree with it exactly, forever.

## Prompts to update when this is decided

- `002.03.00.prompt - static hosting and runtime configuration (draft).md`
- `002.04.00.prompt - backend api enablement for the web ui (draft).md`
- `002.05.00.prompt - membership authorization enforcement (draft).md`
- `005.01.00.prompt - generated api client (draft).md`
- `006.01.00.prompt - companies overview and company view shell (draft).md`
- `007.01.00.prompt - company live activity view (draft).md`
- `008.06.00.prompt - profile and company memberships dialogs (draft).md`

## Detail

### Scoped by default, with an escape hatch

`GET /api/company` returns the caller's own companies unless `?all=true` is given, in which case it returns every company — subject to whatever the caller is permitted to see, once that's enforced.

The point of naming `all` now, before any permission model exists, is that it gives the future gate an obvious place to attach. [ADR-011's phase-02 amendment](ADR-011-authentication-authorization.md#amendment-phase-02-membership-scoping) records the plan: until permission groups exist, `?all=true` is available to any authenticated caller, identical to today's unscoped behaviour. Once groups exist, it's restricted to system administrators, and a non-administrator requesting it gets `403 Forbidden` rather than a silently filtered response — a wrong request should fail loudly, not degrade quietly into a different one.

This ADR only names the parameter and its current, unenforced meaning. The enforcement itself is `002.05.00.prompt - membership authorization enforcement (draft).md`'s job, not this one's.

### Migrating existing callers

Two callers rely on the current "every company" behaviour and need an explicit update, not just a recompile:

- **`tcp-cli list-companies`** — becomes `?all=true` by default, preserving the operator's existing experience. The CLI's whole reason to exist is administering the system, so it keeps the wider view; the web client is the one that should default narrow.
- **Existing API tests** asserting `GET /api/company` returns every seeded company — either add `?all=true` to the request, or seed a `CompanyUser` row for the calling identity, whichever the test is actually trying to verify.

Both are small, mechanical changes. They're called out here because a flipped default won't be caught by the compiler — nothing type-checks against "the operator now sees fewer companies than yesterday." It only shows up as a person noticing something is missing.

### Membership matching must accept both identifier forms

`CompanyUser.identifier` is documented as holding an OIDC subject (`sub`) claim **or** an email address. Company creation writes `sub`; rows added another way may hold an email.

Matching on `sub` alone is the obvious implementation and is wrong — it silently misses those memberships. The user sees an empty overview and no error, which is indistinguishable from "you're not a member of anything".

The query therefore matches `identifier IN (sub, email)`. This is worth a test with an email-keyed row, precisely because the failure is silent.

### Consultations are an approximation

`PendingConsultation` is registered in `api.module.ts` but has no controller. Consultations are visible only as audit events, or indirectly as orphan assignments — assignments with no task — with `mode: 'consultee'`.

`GET /api/assignment?companyId=X&taskId=null`, filtered to that mode, works today with no backend change. What it cannot answer is "who is waiting on whom": a consultation that has been requested but not yet picked up has no assignment, so it does not appear.

That limit is acceptable for the MVP list, and is why the UI must not present the list as complete.

### Widening the company channel

`AuditEventPublisher.publish` routes an audit row to the company channel only when `payload.entity` is `'company'` or `'task'`:

```ts
if (entity === 'company' || entity === 'task') {
  this.companyEvents.emit(wire.companyId, { type: 'audit', event: wire });
}
```

Agent and assignment rows never arrive. Of the live activity view's four lists, only **tasks** can stream today. `primeCompanyEvents` matches — it primes the company signal plus each task's summary, and nothing else.

The fix is a predicate change, not an architecture change. Every audit write already flows through this single publish point, so adding `agent` and `assignment` reuses the existing event bus, Redis channel and SSE endpoint.

The larger half is the priming: the live view must render immediately when it subscribes, so `primeCompanyEvents` needs current agent, consultation and enquiry summaries alongside the task summaries it already sends.

### The stat set is fixed now, deliberately

Per company: active agent count, task counts by status, and open enquiry count. Computed in the same query that resolves memberships.

Naming them is the point. "A few live stats" is not implementable, and an open-ended stat block turns into one request per company.
