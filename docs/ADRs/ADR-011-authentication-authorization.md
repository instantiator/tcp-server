# ADR-011: Authentication and Authorization

Status: Partially Implemented

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

- Full `CompanyMembership` permission flag system (`create_tasks`, `initiate_conversations`, etc.) — no decorator or per-endpoint enforcement exists yet; `JwtAuthGuard` only proves _who_ the caller is, not what they're allowed to do
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

**1. ADR-023's `?mine=true` is a convenience filter, not a security control.**
[ADR-023](ADR-023-backend-api-surface-for-the-web-ui.md) adds membership
scoping to `GET /api/company` so the overview shows the right companies. That is
a _list filter_. `GET /api/company/:id`, `GET /api/task?companyId=…`,
`POST /api/agent/chat/start` and every other route remain unscoped — a user who
knows or guesses an ID still reaches it. Anyone reading this ADR after ADR-023
lands must not conclude the gap is closed.

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

## Consequences

- `JwtAuthGuard` is applied to every user-facing controller (see Implemented above)
- `CompanyUser` entity is used for conversation routing (matching user `knowledgeDomains` and `roles` to query content)
- Fine-grained authorization (permission flags per endpoint) remains a gap — any authenticated user can currently call any user-facing endpoint their token is valid for, with no per-action permission check

## Open Questions / Assumptions

- Password storage: handled entirely by the IdP — tcp-server never touches passwords
- Token refresh: the IdP issues refresh tokens; the client (browser/CLI) handles the refresh flow. tcp-server only validates access tokens.
- The `modify_company` and `define_agent_roles` permissions effectively give full control — consider a dedicated admin role at larger scale
