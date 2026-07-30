# ADR-023: Backend API Surface for the Web UI

**Status:** Proposed (2026-07-30)

## Context

The MVP described in [ADR-020](ADR-020-web-ui-mvp-scope.md) is not deliverable
against tcp-server as it stands. The API was built for `tcp-cli`, a trusted
first-party client run by an operator who already knows which company they mean.
A browser client is a different consumer: it runs on a foreign origin, it must
discover what the signed-in user may see, and it must render four live lists on
one screen.

Six gaps follow from that difference. Each is individually small; together they
determine whether four MVP surfaces can exist at all. They are collected here
because a gap with no owner is a gap discovered in week six — CORS in particular
is nobody's feature and everybody's blocker.

This ADR decides the API changes. It does **not** decide the permission model:
that is [ADR-011](ADR-011-authentication-authorization.md)'s, whose deferred
authorization work is now coming due and is recorded as an amendment there.

## Options considered

### 1. CORS

tcp-server never calls `app.enableCors()`. No browser origin can call it today.

| Option                           | Trade-off                                                                                                                                                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Same-origin reverse proxy**    | The SPA and `/api` share an origin, so CORS never arises, no preflight cost, and cookie-based options stay open. Requires the proxy to exist — which [ADR-029](ADR-029-spa-hosting-and-runtime-configuration.md) proposes anyway |
| `enableCors()` with an allowlist | Independent of hosting shape; needs a configured origin list per environment, and preflight on every non-simple request                                                                                                          |

### 2. Membership-scoped company listing

`GET /api/company` returns **every** company (`listCompanies()`, no filter).
`CompanyUser` is queryable only forwards — `GET /api/company/:companyId/users`
requires knowing the company already.

There is a wrinkle: `CompanyUser.identifier` is documented as "OIDC subject
(`sub`) claim **or** email address". Company creation writes `sub`; rows added
another way may hold an email. A lookup on `sub` alone will silently miss those
memberships — the user sees an empty overview and no error.

| Option                           | Trade-off                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **`GET /api/company?mine=true`** | One endpoint, existing route, opt-in so no caller breaks                                                            |
| `GET /api/me/companies`          | Cleaner REST shape; a second route returning the same entity                                                        |
| Client-side filtering            | No backend change — and it fetches every company name in the system to the browser, then N+1s for members. Rejected |

### 3. Identity

There is no `/api/me`, `/api/user`, or `/api/profile`. The MVP profile dialog is
read-only.

| Option                                       | Trade-off                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Decode the ID token's claims client-side** | Zero backend change. The OIDC provider already supplies `sub`, `name`, `email`. Sufficient for a read-only dialog                     |
| `GET /api/me`                                | Needed once the dialog becomes editable, or once server-held profile data exists that is not in the token. Neither is true in the MVP |

### 4. Consultations

`PendingConsultation` is registered in `api.module.ts` but has **no controller**.
Consultations are visible only as audit events, or indirectly as orphan
assignments with `mode: 'consultee'`.

| Option                                                                             | Trade-off                                                                                                                              |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **`GET /api/assignment?companyId=X&taskId=null`, filtered to `mode: 'consultee'`** | Works today, no backend change. Returns consultee _assignments_, not pending consultations — it cannot answer "who is waiting on whom" |
| A consultations endpoint over `PendingConsultation`                                | Answers the question properly, including still-pending ones. New controller, new DTO                                                   |

### 5. Company event-channel coverage

`AuditEventPublisher.publish` routes to the company channel only when
`payload.entity` is `'company'` or `'task'`:

```ts
if (entity === 'company' || entity === 'task') {
  this.companyEvents.emit(wire.companyId, { type: 'audit', event: wire });
}
```

Agent and assignment rows never arrive. Of the live activity view's four lists,
only **tasks** can stream. `primeCompanyEvents` matches: it primes the company
signal plus each task's `TaskChangeSummary`, and nothing else.

| Option                                   | Trade-off                                                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Widen the predicate and the priming**  | Small, local change at the one publish point every audit write already flows through. Increases company-channel traffic |
| Poll agents, consultations and enquiries | No backend change; the flagship "real-time view" is three-quarters polling                                              |

### 6. Company overview stats

"A few live stats about each company" has no backing endpoint and no definition.
Left unpinned it becomes an N+1 fan-out discovered during implementation.

## Decision

**All six are in scope for phase 02. Four are backend changes; two are resolved
without touching tcp-server.**

| #   | Decision                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Same-origin reverse proxy** (ADR-029), so CORS is not needed. `enableCors()` with an env-driven allowlist stays documented as the fallback for a split-origin deployment |
| 2   | **`GET /api/company?mine=true`**, matching on `sub` **or** the token's `email` claim, so email-keyed rows are found                                                        |
| 3   | **ID token claims, client-side.** No `/api/me` in the MVP                                                                                                                  |
| 4   | **Reuse the orphan-assignment query** for the MVP list; a proper consultations endpoint is deferred                                                                        |
| 5   | **Widen the company channel** to carry agent and assignment rows for the company, and extend `primeCompanyEvents` to match                                                 |
| 6   | **A fixed, cheap stat set** computed server-side in the `?mine=true` response                                                                                              |

### Membership matching must accept both identifier forms

Matching on `sub` alone is the obvious implementation and is wrong for any
`CompanyUser` row created with an email identifier. The query matches
`identifier IN (sub, email)`. This is worth a test with an email-keyed row,
because the failure is an empty list rather than an error — indistinguishable
from "you are not a member of anything".

### Widening the company channel is a predicate change, not an architecture change

Every audit write already flows through `AuditEventPublisher.publish`
(`docs/prompts/010.5.1` A.7 made it the single publish point). Adding `agent`
and `assignment` to the company-channel predicate reuses the existing
`KeyedEventBus`, the existing Redis channel, and the existing SSE endpoint. The
matching priming work is the larger half: the live view must render immediately
on subscribe, so `primeCompanyEvents` needs current agent, consultation and
enquiry summaries alongside the task summaries it already sends.

### The stat set is fixed now, deliberately

Per company: active agent count, task counts by status, and open enquiry count.
Computed in the same query that resolves memberships. Naming them here is the
point — "a few live stats" is not implementable, and an open-ended stat block
becomes a fan-out.

### What is deliberately not done

No `/api/me` and no consultations controller. Both are real gaps and neither
blocks the MVP: the profile dialog is read-only and the consultations list needs
only what the assignment query returns. Adding them now would be building for a
release that has not been specified.

## Consequences

- Four changes land in tcp-server: the `?mine=true` filter with its stat set, the
  publisher predicate, the extended priming, and the fallback CORS configuration.
  Only the first two are user-visible.
- **The consultations list is an approximation.** It shows consultee
  _assignments_, not pending consultations — a consultation still waiting to be
  picked up does not appear. The UI must not imply completeness, and the
  implementing prompt should say so.
- Company-channel traffic increases: every agent state change in the company now
  reaches every subscriber of that company's stream. Acceptable at the current
  scale, and the first thing to look at if the live view becomes chatty.
- The `?mine=true` filter is opt-in, so `tcp-cli list-companies` and the existing
  API tests are unaffected. The unfiltered default remains — which is a
  **finding, not a feature**: it is exactly the exposure ADR-011's amendment
  addresses.
- Deriving identity from token claims couples the profile dialog to the IdP's
  claim set. Zitadel supplies `sub`, `name` and `email`; a provider that does not
  would need `/api/me` after all.
- No migration. All six items are query, routing, or configuration changes —
  `PendingConsultation` and `CompanyUser` already exist with the needed columns.

## Alternatives considered

- **Client-side company filtering.** No backend change, and it ships every
  company name in the system to every authenticated browser, then N+1s for
  membership. Rejected on both exposure and request count.
- **A full `/api/me` with server-held profile.** Rejected as speculative: nothing
  in the MVP writes profile data, and the token already carries what the dialog
  renders.
- **Polling the three non-streaming lists.** Genuinely simpler, and rejected
  because it makes the flagship surface three-quarters not-live, in exchange for
  avoiding a two-line predicate change.
- **A dedicated `/api/company/:id/activity` aggregate endpoint** returning all
  four lists in one call. Attractive for the initial render and rejected as a
  second source of truth: the SSE stream already carries these entities, so an
  aggregate endpoint would need to agree with it exactly, forever.

## Prompts to update when this is decided

- `002.03.00.prompt - static hosting and runtime configuration (draft).md`
- `002.04.00.prompt - backend api enablement for the web ui (draft).md`
- `002.05.00.prompt - membership authorization enforcement (draft).md`
- `005.01.00.prompt - generated api client (draft).md`
- `006.01.00.prompt - companies overview and company view shell (draft).md`
- `007.01.00.prompt - company live activity view (draft).md`
- `008.06.00.prompt - profile and company memberships dialogs (draft).md`
