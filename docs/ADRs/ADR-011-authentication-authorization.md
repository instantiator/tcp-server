# ADR-011: Authentication and Authorization

Status: Partially Implemented (amended)

## Context

tcp-server exposes a REST API. Access to companies and their resources (tasks, conversations, agent roles, shared storage) must be controlled. A company has a list of users, each with a set of permissions.

Agents are **not** auth subjects — they run as trusted internal processes inheriting the company context. Auth applies only to human (or external service) callers of the REST API.

## Permission model

Each company membership record associates a user with a set of permission flags:

| Permission               | Allows                                                     |
| ------------------------ | ---------------------------------------------------------- |
| `create_tasks`           | Submit new tasks and upload supporting materials           |
| `initiate_conversations` | Open a conversation thread with an agent role              |
| `access_storage`         | Read from and write to company shared storage via the API  |
| `modify_company`         | Update company settings, role definitions, MCP server list |
| `define_agent_roles`     | Create, update, and delete role definitions                |

A user can hold multiple permissions. Company creation grants the creator all permissions.

## Auth mechanism options

| Option                           | Notes                                                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **JWT (self-issued)**            | NestJS Guards + Passport JWT. No external service. Standard, well-documented in the NestJS ecosystem.                       |
| **OAuth2 / OIDC (external IdP)** | Delegates identity to an existing provider (Keycloak, Auth0, Okta, etc.). Federated identity; production-grade MFA support. |
| **API keys**                     | Simplest for machine-to-machine. Less suitable for interactive user access.                                                 |

## Decision

**OAuth2 / OIDC with NestJS Passport Guards**, delegating identity to an external IdP.

### Identity provider

The default IdP is **Keycloak**, provided as an optional Docker Compose service (`--profile auth`). Any OIDC-compliant IdP (Auth0, Okta, Azure AD, etc.) can be used by setting `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET`.

> This sub-decision is superseded by [ADR-017](ADR-017-oidc-provider-selection.md): the default IdP is changing from Keycloak to Zitadel. See that ADR for the rationale and migration plan; the rest of this ADR (permission model, company-permissions design) is unaffected.

tcp-server validates incoming requests by:

1. Extracting the Bearer token from the `Authorization` header
2. Fetching the IdP's JWKS from `{OIDC_ISSUER_URL}/.well-known/jwks.json` (cached)
3. Verifying the token signature, expiry, audience, and issuer

### Company permissions

Identity (who you are) is handled by the IdP. Authorisation (what you can do in a given company) is handled by tcp-server:

- `CompanyMembership` entity in PostgreSQL: `(user_id, company_id, permissions[])`
- Permissions are checked by a `@RequirePermission()` decorator on each endpoint
- A user with access to two companies holds separate tokens; company context is established by the API path or request body

### User account management

tcp-server provides thin wrappers around the Keycloak Admin REST API for common operations, so developers only need to interact with the tcp-server API for the day-to-day cases:

| tcp-server endpoint       | Proxied Keycloak operation       |
| ------------------------- | -------------------------------- |
| `POST /users`             | Create user in the `tcp` realm   |
| `PATCH /users/:id/status` | Enable or disable a user account |

For advanced IdP features (MFA, password policy, social login, federation), use the Keycloak admin UI directly at `http://localhost:8080`.

### Internal service trust

tcp-server ↔ tcp-agent communication over BullMQ is internal to Docker Compose. No auth is applied between these services — network-level trust is sufficient within the Compose network. **Do not expose the Redis port outside the Docker network.**

## Implementation status

### What changed from the original plan

The `CompanyMembership` entity described here was simplified. The implemented entity is **`CompanyUser`**, which captures identity and routing information without the five discrete permission flags. The `@RequirePermission()` decorator described below was never built — no such decorator exists in the codebase, and no permission-flag comments are attached to endpoints. `JwtAuthGuard` (authentication only, not fine-grained authorization) is applied to every user-facing controller instead; see Implemented/Deferred below.

### Implemented

- `passport-jwt` + `jwks-rsa` + `@nestjs/passport` installed; `JwtStrategy` fetches JWKS on first use (cached)
- `AuthModule` wired into tcp-server's `AppModule`; `@UseGuards(JwtAuthGuard)` applied to every user-facing controller (company, role, agent, task, conversation, storage proxy, knowledge, model, company-user); internal-only endpoints use the separate `InternalApiKeyGuard` instead (`X-Internal-Api-Key`, see [ADR-001 Amendment](ADR-001-service-architecture.md#amendment-as-implemented-01029))
- **`CompanyUser` entity** in `libs/tcp-shared/src/models/`: `(id, companyId, identifier, name, memberType, roles[], knowledgeDomains[], createdAt)`. Used for query routing in the conversation flow.
- Since 009.2: `POST /api/company` auto-creates a `CompanyUser` with `memberType: 'creator'` for the requesting user (from the JWT `sub`/`email` claims), skipped if one already exists for that `(companyId, identifier)` pair.
- `GET /api/company/:companyId/users`, `POST /api/company/:companyId/users`, `PATCH /api/company/:companyId/users/:userId`, `DELETE /api/company/:companyId/users/:userId` — full CRUD
- IdP setup documented (Keycloak at the time; see the 010.7 amendment below for the move to Zitadel)
- `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` required at startup (validated by ConfigModule)

### Deferred

- Full `CompanyMembership` permission flag system (`create_tasks`, `initiate_conversations`, etc.) — no decorator or per-flag enforcement exists; **membership itself is enforced since 002.05** (see the [amendment](#amendments-as-implemented-00205)), so a caller reaches only companies they belong to, but any member may take any action within one
- `POST /users` and `PATCH /users/:id/status` Keycloak proxy endpoints — deferred

<a id="amendments-as-implemented-0107"></a>

## Amendments as implemented (010.7) — Zitadel replaces Keycloak

The identity-provider sub-decision recorded above chose Keycloak. That choice is
superseded by [ADR-017](ADR-017-oidc-provider-selection.md): the bundled provider
is **Zitadel**, and the migration is complete. The authentication _design_ is
unchanged — any standards-compliant OIDC provider still works, tokens are still
validated against the provider's JWKS, and `JwtAuthGuard` still guards every
user-facing controller. What changed is which provider ships in the box, and a
few things that follow from it:

- **`docs/keycloak-setup.md` no longer exists.** Setup is documented in
  [docs/zitadel-setup.md](../zitadel-setup.md), with the provider-agnostic
  picture in [docs/authentication.md](../authentication.md).
- **The IdP-admin proxy endpoints (`POST /users`, `PATCH /users/:id/status`)
  are dropped, not merely deferred.** They existed to wrap Keycloak's admin API;
  nothing replaced them, and user administration is done in the provider's own
  console.
- **Zitadel must issue JWTs, not its default opaque tokens.** Every OIDC
  application and machine user needs `accessTokenType: OIDC_TOKEN_TYPE_JWT`
  (apps) or `ACCESS_TOKEN_TYPE_JWT` (machine users), or JWKS verification cannot
  parse the token at all. `scripts/start-deployment.sh` sets this for everything
  it creates.
- **Token acquisition moved from ROPC to the OAuth 2.0 Device Authorization
  Grant.** Zitadel does not support the password grant under any configuration,
  so `tcp-cli get-token` proxies the device flow through tcp-server
  (`POST /api/auth/device`), keeping the client secret server-side.

The gap this ADR names in Consequences — no per-action permission enforcement —
is unaffected and still open.

<a id="amendment-phase-02-membership-scoping"></a>

## Amendment (phase 02) — membership scoping for the web UI

_2026-07-30._ The deferred authorization gap is coming due. Until now the only
client has been `tcp-cli`, run by an operator who already has the credentials
and the intent to administer the system; the gap's practical exposure was
limited by there being no other way in. A browser client with a **public** OIDC
application ([ADR-024](ADR-024-browser-oidc-client-and-token-handling.md))
changes that: any account the provider will issue a token to can reach every
company in the system, read its tasks and knowledge, chat with its agents, and
write to it.

Nothing about the permission model above changes. Two things are recorded:

**1. ADR-023 scopes one list; it does not enforce anything.**
[ADR-023](ADR-023-backend-api-surface-for-the-web-ui.md) makes
`GET /api/company` return the caller's own companies by default, with
`?all=true` as an explicit, named escape hatch — a real improvement over an
unscoped default, and still not a security control: `?all=true` carries no
permission check yet, so any authenticated caller can still ask for it and get
every company, exactly as today. `GET /api/company/:id`,
`GET /api/task?companyId=…`, `POST /api/agent/chat/start` and every other route
remain entirely unscoped regardless of this change — a user who knows or
guesses an ID still reaches it. Anyone reading this ADR after ADR-023 lands
must not conclude the gap is closed; `?all=true` is exactly the flag this
amendment's enforcement work (point 2) will eventually gate to system
administrators.

**2. Enforcement is a pre-deployment gate, not a backlog item.** The permission
flags in the model above need actual enforcement — a guard resolving the caller's
`CompanyUser` for the company an action targets, and rejecting when there is
none. This does not block local MVP development, where the operator is the only
user. It **does** block any deployment reachable beyond localhost. Drafted as
`002.05.00.prompt - membership authorization enforcement (draft).md` in phase 02
so it has a number and an owner rather than living in this Consequences list.

One implementation note carried over from ADR-023: `CompanyUser.identifier`
holds an OIDC `sub` **or** an email address, so any enforcement lookup must
match both. Matching on `sub` alone silently denies users whose membership rows
were created with an email — a failure that looks like a permissions bug and is
a data-shape bug.

<a id="amendments-as-implemented-00205"></a>

## Amendments as implemented (002.05) — membership is enforced

_2026-08-05._ The gate the amendment above names is now closed. **Membership**
is enforced on every user-facing route; the five permission **flags** are not,
and remain deferred (see below).

**How it works.** `CompanyMembershipGuard` runs alongside `JwtAuthGuard` on
every user-facing controller. Each route declares how its company is found:

| Declaration                         | Meaning                                                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@CompanyScope({ from, key, via })` | Resolve the company from a param, query value or body field — directly, or through the task, agent, assignment, role, conversation or storage key it names |
| `@CompanyScopeRequired(message)`    | The 400 to raise when a request carries none of those handles, preserving each list route's existing wording                                               |
| `@NoCompanyScope(reason)`           | Reachable by any authenticated caller because it names no company; the reason is mandatory                                                                 |
| `@AdminOnly()`                      | Restricted to the configured administrators                                                                                                                |

**Deny by default.** A route on a guarded controller that declares none of
these is refused at request time, and `route-audit.spec.ts` fails the build for
it. That spec walks the module graph statically and asserts the status of every
route, so the enumeration this work required cannot go stale — a route added
later cannot open by omission.

**Administrators are a configured list, not a group.** `TCP_ADMIN_IDENTIFIERS`
holds comma-separated `sub` claims and/or email addresses. It gates `?all=true`
on `GET /api/company` and the `/api/system` routes, and it lets the `tcp-cli`
operator administer companies they were never added to. **The default is empty
— nobody is an administrator**, so a deployment that forgets to set it loses an
administrative view rather than granting one. `start-deployment.sh` writes the
bootstrapped human and machine user ids to the `.local` override, so local
development and the api test tier keep working unchanged. This is the interim
answer; permission groups replace it.

**Refusals are 403, uniformly.** A non-member asking for a company gets
`403 Forbidden`, never an empty list — quietly degrading one request into a
different one hides the fact that the caller lacks the access. A handle naming
nothing is a 404, kept distinct from a membership failure so a permissions
problem never reads as a missing record. The trade-off is that a 403 confirms
an id exists; recorded in phase 02's unresolved notes.

**Two error codes changed as a consequence.** Guards run before validation
pipes, and the guard resolves the company before the handler runs:
`GET /api/company/:id` for an unknown id is now 404 rather than 200 with an
empty body (which the e2e suite already carried a TODO asking for), and
`POST /api/role` with a malformed `companyId` is 404 rather than 400 — a
company handle is UUID-or-slug, so a malformed one is simply a slug naming
nothing. `GET /api/conversation` now requires `companyId`: an unfiltered list
spans every company.

**Out of scope, deliberately.** `/internal/*` keeps `InternalApiKeyGuard` and
no membership check — a different trust boundary, since tcp-agent has no
membership and needs none.

**Still deferred: the permission flags.** `CompanyUser` has no permission
columns, only `memberType`. Enforcing `create_tasks`, `initiate_conversations`,
`access_storage`, `modify_company` and `define_agent_roles` needs a migration,
a defaulting policy, `@RequirePermission()`, and a surface to set them — carried
into `002.01` (company configuration view). Until then, **any member of a
company may take any action within it**.

## Consequences

- `JwtAuthGuard` is applied to every user-facing controller (see Implemented above)
- `CompanyUser` entity is used for conversation routing (matching user `knowledgeDomains` and `roles` to query content), and since 002.05 it is also the access control: membership decides who may reach a company at all
- Fine-grained authorization (permission flags per endpoint) remains a gap — a member of a company can take any action within it, with no per-action permission check. Membership itself is enforced (see the 002.05 amendment)

## Open Questions / Assumptions

- Password storage: handled entirely by the IdP — tcp-server never touches passwords
- Token refresh: the IdP issues refresh tokens; the client (browser/CLI) handles the refresh flow. tcp-server only validates access tokens.
- The `modify_company` and `define_agent_roles` permissions effectively give full control — consider a dedicated admin role at larger scale
