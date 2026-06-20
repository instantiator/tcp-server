# LCP Server — Documentation

## Operations

Day-to-day guides for running and maintaining the system.

| Document                                | Description                                                        |
| --------------------------------------- | ------------------------------------------------------------------ |
| [lcp-agent](lcp-agent.md)               | Creating roles, starting agents, model compatibility check         |
| [Setup Checklist](setup-checklist.md)   | Step-by-step first-time setup from clone to running tests          |
| [Scripts](scripts.md)                   | All scripts in `scripts/` — purpose, options, and usage examples   |
| [Testing](testing.md)                   | Testing strategy, four-tier overview, and how to run each suite    |
| [Services](services.md)                 | All Docker Compose services — ports, dependencies, and purpose     |
| [Database Migrations](db-migrations.md) | How to create, register, and run TypeORM migrations                |
| [Keycloak Setup](keycloak-setup.md)     | Configuring the OIDC provider for local development and production |

## Architecture Decision Records

Design decisions made during the project, with context and rationale.

| ADR                                                     | Title                                          | Status                | Notes                                                                                                                  |
| ------------------------------------------------------- | ---------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [ADR-001](ADRs/ADR-001-service-architecture.md)         | Service Architecture                           | Partially Implemented | Monorepo confirmed. lcp-agent now has a working BullMQ worker and LangGraph agent loop.                                |
| [ADR-002](ADRs/ADR-002-agent-loop-framework.md)         | Agent Loop Framework                           | Partially Implemented | LangGraph `StateGraph` agent loop implemented with PostgreSQL checkpoint store. MCP tools and RAG deferred.            |
| [ADR-003](ADRs/ADR-003-llm-provider-abstraction.md)     | LLM Provider Abstraction                       | Partially Implemented | `buildChatModel` factory for `lm-studio` and `openai` providers. Anthropic provider deferred.                         |
| [ADR-004](ADRs/ADR-004-database-strategy.md)            | Database Strategy                              | Partially Implemented | PostgreSQL + pgvector wired; initial migration runs on startup. pgvector not yet used (no vector columns or queries).  |
| [ADR-005](ADRs/ADR-005-agent-state-persistence.md)      | Agent State Persistence and Resumability       | Partially Implemented | `LcpAgent` entity with `status` and `threadId`. PostgresSaver checkpoint store. Resume via BullMQ re-dispatch.        |
| [ADR-006](ADRs/ADR-006-agent-memory-architecture.md)    | Agent Memory Architecture                      | Proposed              |                                                                                                                        |
| [ADR-007](ADRs/ADR-007-shared-company-storage.md)       | Shared Company Storage                         | Partially Implemented | MinIO in Docker Compose with volume. No storage MCP server yet.                                                        |
| [ADR-008](ADRs/ADR-008-audit-logging.md)                | Audit Logging                                  | Partially Implemented | `audit_event` table created; `AuditEvent` writes on LLM request/response, tool calls, and state changes.              |
| [ADR-009](ADRs/ADR-009-containerization-strategy.md)    | Containerization Strategy                      | Partially Implemented | Full Docker Compose stack with health checks and volumes. MCP servers deferred (child processes, not containers).      |
| [ADR-010](ADRs/ADR-010-orchestration-design.md)         | Orchestration Design                           | Partially Implemented | BullMQ `agent-jobs` queue wired. lcp-server enqueues; lcp-agent `AgentWorkerService` consumes.                        |
| [ADR-011](ADRs/ADR-011-authentication-authorization.md) | Authentication and Authorization               | Accepted              | `JwtStrategy` + `JwtAuthGuard` wired. Guards not yet applied to any endpoint. User/CompanyMembership entities pending. |
| [ADR-012](ADRs/ADR-012-human-in-the-loop.md)            | Human-in-the-Loop and User-Agent Conversations | Proposed              |                                                                                                                        |

### Status definitions

| Status                    | Meaning                                         |
| ------------------------- | ----------------------------------------------- |
| **Proposed**              | Decision documented; not yet built              |
| **Accepted**              | Decision reviewed and confirmed; ready to build |
| **Partially Implemented** | Work in progress; some components built         |
| **Implemented**           | Fully built and in use                          |
| **Superseded**            | Replaced by a later ADR                         |

## Reference

| Document                   | Description                                                     |
| -------------------------- | --------------------------------------------------------------- |
| [licenses.md](licenses.md) | Dependency license report — auto-generated, do not edit by hand |

## Planning

Historical planning documents and session prompts are in [prompts/](prompts/).

> [!NOTE]
> These are records of how the project was designed, not active documentation.
