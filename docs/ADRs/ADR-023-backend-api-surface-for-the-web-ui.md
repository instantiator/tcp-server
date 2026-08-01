# ADR-023: Backend API Surface for the Web UI

**Status:** Proposed (2026-07-30)

## Context

The MVP described in [ADR-020](ADR-020-web-ui-mvp-scope.md) cannot be built against tcp-server as it stands.

The API was built for `tcp-cli` — a trusted client, run by an operator who already knows which company they mean. A browser is a different kind of consumer:

- it runs on a different address to the API
- it has to discover what the signed-in user is allowed to see
- it shows four live lists on one screen

This ADR decides the API changes needed. It does **not** decide the permission model — that belongs to [ADR-011](ADR-011-authentication-authorization.md), whose deferred authorization work is now coming due and is recorded as an amendment there.

## What needs deciding

Six gaps. Each is individually small, but together they decide whether four MVP surfaces can exist at all.

| #   | Gap                                                                                 |
| --- | ----------------------------------------------------------------------------------- |
| 1   | **CORS.** tcp-server never calls `app.enableCors()`, so no browser can call it      |
| 2   | **Membership scoping.** `GET /api/company` returns _every_ company, with no filter  |
| 3   | **Identity.** There is no `/api/me`, so the profile dialog has no source            |
| 4   | **Consultations.** `PendingConsultation` has no controller, so they can't be listed |
| 5   | **Live coverage.** The company event channel carries only company and task rows     |
| 6   | **Company stats.** "A few live stats per company" has no endpoint and no definition |

They are collected in one ADR because a gap with no owner is a gap discovered late. CORS in particular is nobody's feature and everybody's blocker.

## Options considered

| #   | Chosen                                        | Alternative                                          |
| --- | --------------------------------------------- | ---------------------------------------------------- |
| 1   | Same-origin reverse proxy — CORS never arises | `enableCors()` with a per-environment allowlist      |
| 2   | `GET /api/company?mine=true`                  | `GET /api/me/companies`, or filtering in the browser |
| 3   | Read the ID token's claims in the browser     | Add `GET /api/me`                                    |
| 4   | Reuse the orphan-assignment query             | Build a consultations endpoint                       |
| 5   | Widen the company channel                     | Poll the three lists that don't stream               |
| 6   | A fixed stat set, computed server-side        | An open-ended stat block, computed per company       |

## Decision

**All six are in scope for phase 02. Four are backend changes; two need no server work at all.**

| #   | Decision                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Same-origin reverse proxy** ([ADR-029](ADR-029-spa-hosting-and-runtime-configuration.md)), so CORS isn't needed. `enableCors()` stays documented as the fallback |
| 2   | **`GET /api/company?mine=true`**, matching on `sub` **or** `email` — see [membership matching](#membership-matching-must-accept-both-identifier-forms)             |
| 3   | **ID token claims, read in the browser.** No `/api/me` in the MVP                                                                                                  |
| 4   | **Reuse the orphan-assignment query.** A proper endpoint is deferred — see [consultations](#consultations-are-an-approximation)                                    |
| 5   | **Widen the company channel** to carry agent and assignment rows — see [live coverage](#widening-the-company-channel)                                              |
| 6   | **A fixed, cheap stat set** returned with the `?mine=true` response — see [stats](#the-stat-set-is-fixed-now-deliberately)                                         |

Deliberately **not** done: no `/api/me`, and no consultations controller. Both are real gaps; neither blocks the MVP. Adding them now would be building for a release that hasn't been specified.

## Consequences

- Four changes land in tcp-server: the `?mine=true` filter with its stat set, the event-channel widening, the extended priming, and the fallback CORS configuration. Only the first two are visible to a user.
- **The consultations list is an approximation.** It shows consultee _assignments_, not pending consultations, so a consultation still waiting to be picked up doesn't appear. The UI must not imply the list is complete.
- Company event traffic increases — every agent state change now reaches every subscriber of that company's stream. Fine at current scale, and the first thing to look at if the live view gets noisy.
- The `?mine=true` filter is opt-in, so `tcp-cli list-companies` and the existing API tests are unaffected. The unfiltered default remains — which is a **finding, not a feature**, and is exactly what the ADR-011 amendment addresses.
- Reading identity from token claims ties the profile dialog to the identity provider's claim set. Zitadel supplies `sub`, `name` and `email`; a provider that didn't would need `/api/me` after all.
- No database migration. All six are query, routing or configuration changes — the entities already have the columns needed.

## Alternatives considered

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
