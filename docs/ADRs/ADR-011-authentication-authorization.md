# ADR-011: Authentication and Authorization

Status: Partially Implemented

## Context

lcp-server exposes a REST API. Access to companies and their resources (tasks, conversations, agent roles, shared storage) must be controlled. A company has a list of users, each with a set of permissions.

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

lcp-server validates incoming requests by:

1. Extracting the Bearer token from the `Authorization` header
2. Fetching the IdP's JWKS from `{OIDC_ISSUER_URL}/.well-known/jwks.json` (cached)
3. Verifying the token signature, expiry, audience, and issuer

### Company permissions

Identity (who you are) is handled by the IdP. Authorisation (what you can do in a given company) is handled by lcp-server:

- `CompanyMembership` entity in PostgreSQL: `(user_id, company_id, permissions[])`
- Permissions are checked by a `@RequirePermission()` decorator on each endpoint
- A user with access to two companies holds separate tokens; company context is established by the API path or request body

### User account management

lcp-server provides thin wrappers around the Keycloak Admin REST API for common operations, so developers only need to interact with the lcp-server API for the day-to-day cases:

| lcp-server endpoint       | Proxied Keycloak operation       |
| ------------------------- | -------------------------------- |
| `POST /users`             | Create user in the `lcp` realm   |
| `PATCH /users/:id/status` | Enable or disable a user account |

For advanced IdP features (MFA, password policy, social login, federation), use the Keycloak admin UI directly at `http://localhost:8080`.

### Internal service trust

lcp-server ↔ lcp-agent communication over BullMQ is internal to Docker Compose. No auth is applied between these services — network-level trust is sufficient within the Compose network. **Do not expose the Redis port outside the Docker network.**

## Implementation status

### What changed from the original plan

The `CompanyMembership` entity described here was simplified. The implemented entity is **`CompanyUser`**, which captures identity and routing information without the five discrete permission flags. The permission flags are preserved as an intervention point — a `@RequirePermission()` no-op decorator is wired into each endpoint with the relevant flag annotated in a comment. Enabling real enforcement is a one-line change per endpoint.

### Implemented

- `passport-jwt` + `jwks-rsa` + `@nestjs/passport` installed; `JwtStrategy` fetches JWKS on first use (cached)
- `AuthModule` wired into lcp-server's `AppModule`; `JwtAuthGuard` available for any controller
- **`CompanyUser` entity** in `libs/lcp-shared/src/models/`: `(id, companyId, identifier, name, memberType, roles[], knowledgeDomains[], createdAt)`. Used for query routing in the conversation flow.
- Since 009.2: `POST /api/company` auto-creates a `CompanyUser` with `memberType: 'creator'` for the requesting user (from the JWT `sub`/`email` claims), skipped if one already exists for that `(companyId, identifier)` pair.
- `GET /api/company/:companyId/users`, `POST /api/company/:companyId/users`, `PATCH /api/company/:companyId/users/:userId`, `DELETE /api/company/:companyId/users/:userId` — full CRUD
- Keycloak setup documented in `docs/keycloak-setup.md`
- `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` required at startup (validated by ConfigModule)

### Deferred

- Full `CompanyMembership` permission flag system (`create_tasks`, `initiate_conversations`, etc.) — deferred; `@RequirePermission()` decorator is a no-op placeholder
- Guards applied to API endpoints — `JwtAuthGuard` exists but is not yet applied to any endpoint
- `POST /users` and `PATCH /users/:id/status` Keycloak proxy endpoints — deferred

## Consequences

- `JwtAuthGuard` available for any controller; not yet applied to any endpoint
- `CompanyUser` entity is used for conversation routing (matching user `knowledgeDomains` and `roles` to query content)
- Per-endpoint permission annotations (`// permission: create_tasks`) mark where guards will be applied when the permission system is enabled

## Open Questions / Assumptions

- Password storage: handled entirely by the IdP — lcp-server never touches passwords
- Token refresh: the IdP issues refresh tokens; the client (browser/CLI) handles the refresh flow. lcp-server only validates access tokens.
- The `modify_company` and `define_agent_roles` permissions effectively give full control — consider a dedicated admin role at larger scale
