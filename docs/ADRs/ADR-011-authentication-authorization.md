# ADR-011: Authentication and Authorization

Status: Proposed

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

| Option                           | Notes                                                                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **JWT (self-issued)**            | NestJS Guards + Passport JWT. No external service. Standard, well-documented in the NestJS ecosystem.                        |
| **OAuth2 / OIDC (external IdP)** | Delegates identity to an existing provider (Google, GitHub, etc.). More setup; better for production multi-user deployments. |
| **API keys**                     | Simplest for machine-to-machine. Less suitable for interactive user access.                                                  |

## Decision

**JWT with NestJS Guards** for the initial implementation.

NestJS's `@UseGuards(JwtAuthGuard)` pattern is idiomatic for this stack. The JWT payload carries:

```typescript
interface JwtPayload {
  sub: string; // user ID
  company_id: string; // which company this token is scoped to
  permissions: Permission[];
}
```

A separate token is issued per company — a user with access to two companies holds two tokens. This scopes all requests to a single company and avoids accidentally cross-company operations.

Tokens are issued by lcp-server's `/auth/login` endpoint and have a configurable expiry (default 24 hours).

### Internal service trust

lcp-server ↔ lcp-agent communication over BullMQ is internal to Docker Compose. No auth is applied between these services — network-level trust is sufficient within the Compose network. **Do not expose the Redis port outside the Docker network.**

### Future: external IdP

OAuth2/OIDC integration is the natural upgrade path when multi-user production deployments require federated identity. The NestJS Guards pattern accommodates this by swapping the JWT strategy for an OIDC strategy without changing controllers.

## Consequences

- A `User` entity and a `CompanyMembership` entity (user + company + permissions) are added to `src/models/`
- `POST /auth/login` and `POST /auth/register` endpoints added to lcp-server
- All existing and new company endpoints require a valid JWT scoped to the relevant company
- NestJS `@UseGuards` and a custom `@RequirePermission()` decorator enforce per-endpoint permission checks
- Unit tests mock the JWT Guard; e2e tests issue real tokens against a test company

## Open Questions / Assumptions

- Password storage: bcrypt hashing (industry standard); never store plaintext passwords
- Token refresh: a `/auth/refresh` endpoint is needed for long-running sessions; defer until first use
- The `modify_company` and `define_agent_roles` permissions effectively give a user full control — consider whether a separate admin role is needed at larger scale
