# LCP ADR Implementation Status

Tracks the implementation state of each architectural decision.

| ADR | Title | Status |
| --- | ----- | ------ |
| [ADR-001](./ADR-001-service-architecture.md) | Service Architecture | Accepted |
| [ADR-002](./ADR-002-agent-loop-framework.md) | Agent Loop Framework | Proposed |
| [ADR-003](./ADR-003-llm-provider-abstraction.md) | LLM Provider Abstraction | Proposed |
| [ADR-004](./ADR-004-database-strategy.md) | Database Strategy | Partially Implemented |
| [ADR-005](./ADR-005-agent-state-persistence.md) | Agent State Persistence and Resumability | Proposed |
| [ADR-006](./ADR-006-agent-memory-architecture.md) | Agent Memory Architecture | Proposed |
| [ADR-007](./ADR-007-shared-company-storage.md) | Shared Company Storage | Partially Implemented |
| [ADR-008](./ADR-008-audit-logging.md) | Audit Logging | Accepted |
| [ADR-009](./ADR-009-containerization-strategy.md) | Containerization Strategy | Partially Implemented |
| [ADR-010](./ADR-010-orchestration-design.md) | Orchestration Design | Accepted |
| [ADR-011](./ADR-011-authentication-authorization.md) | Authentication and Authorization | Accepted |
| [ADR-012](./ADR-012-human-in-the-loop.md) | Human-in-the-Loop and User-Agent Conversations | Proposed |

## Status definitions

| Status | Meaning |
| ------ | ------- |
| **Proposed** | Decision documented; not yet built |
| **Accepted** | Decision reviewed and confirmed; ready to build |
| **Partially Implemented** | Work in progress; some components built |
| **Implemented** | Fully built and in use |
| **Superseded** | Replaced by a later ADR |

## Notes on current implementation state

- **ADR-001 (Accepted)**: Monorepo structure confirmed — `apps/lcp-server`, `apps/lcp-agent`, `libs/lcp-shared`. Docker Compose wires the services. lcp-agent is a stub (no agent loop yet).
- **ADR-004 (Partially Implemented)**: PostgreSQL driver configured; TypeORM switches to postgres when `DATABASE_URL` is set. pgvector extension created by initial migration. pgvector not yet used (no vector columns or queries).
- **ADR-007 (Partially Implemented)**: MinIO in Docker Compose with volume. No storage MCP server yet.
- **ADR-008 (Accepted)**: Architecture confirmed; hybrid PostgreSQL + MinIO. `audit_events` table not yet created (pending ADR-004 full implementation).
- **ADR-009 (Partially Implemented)**: Single Docker Compose stack with all services, health checks, startup ordering, and volumes. MCP servers deferred (child processes, not containers).
- **ADR-010 (Accepted)**: Redis in Docker Compose; BullMQ workers not yet implemented.
- **ADR-011 (Accepted)**: OIDC/Keycloak decided. `JwtStrategy` + `JwtAuthGuard` wired into lcp-server. Auth guards not yet applied to any endpoint. User/CompanyMembership entities pending.
