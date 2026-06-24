# LCP Server — Documentation

## Operations

Day-to-day guides for running and maintaining the system.

| Document                                  | Description                                                        |
| ----------------------------------------- | ------------------------------------------------------------------ |
| [lcp-agent](lcp-agent.md)                 | Creating roles, starting agents, model compatibility check         |
| [Setup Checklist](setup-checklist.md)     | Step-by-step first-time setup from clone to running tests          |
| [Scripts](scripts.md)                     | All scripts in `scripts/` — purpose, options, and usage examples   |
| [Testing](testing.md)                     | Testing strategy, four-tier overview, and how to run each suite    |
| [Manual Testing](manual-testing/start.md) | Structured manual test guide — infrastructure through MCP servers  |
| [Services](services.md)                   | All Docker Compose services — ports, dependencies, and purpose     |
| [Database Migrations](db-migrations.md)   | How to create, register, and run TypeORM migrations                |
| [Keycloak Setup](keycloak-setup.md)       | Configuring the OIDC provider for local development and production |

## Architecture Decision Records

Design decisions made during the project, with context and rationale.

| ADR                                                           | Title                                          | Status                | Notes                                                                                                                                                               | Outstanding                                                                                                            |
| ------------------------------------------------------------- | ---------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [ADR-001](ADRs/ADR-001-service-architecture.md)               | Service Architecture                           | Partially Implemented | Monorepo confirmed. lcp-agent has a working BullMQ worker, LangGraph agent loop, RAG retrieval, and MCP tool node.                                                  | Anthropic LLM provider; auth guards applied to API endpoints; `Task` entity and task lifecycle                         |
| [ADR-002](ADRs/ADR-002-agent-loop-framework.md)               | Agent Loop Framework                           | Partially Implemented | LangGraph `StateGraph` with PostgreSQL checkpoint store, RAG injection, and conditional MCP `ToolNode`. Anthropic provider deferred.                                | Anthropic provider; prompt part 6 (pre-fetched MCP responses); multi-agent coordination graph (planner + workers)      |
| [ADR-003](ADRs/ADR-003-llm-provider-abstraction.md)           | LLM Provider Abstraction                       | Partially Implemented | `buildChatModel` factory for `lm-studio` and `openai` providers. Anthropic provider deferred.                                                                       | Anthropic provider (`claude-*` models; no `/v1/embeddings` — requires separate `embeddingConfig`)                      |
| [ADR-004](ADRs/ADR-004-database-strategy.md)                  | Database Strategy                              | Partially Implemented | PostgreSQL + pgvector wired. `KnowledgeChunk` entity uses vector columns with IVFFlat index for RAG retrieval.                                                      | IVFFlat index requires ≥1000 rows before it outperforms a sequential scan; no action needed until data volume grows    |
| [ADR-005](ADRs/ADR-005-agent-state-persistence.md)            | Agent State Persistence and Resumability       | Partially Implemented | `LcpAgent` entity with `status` and `threadId`. PostgresSaver checkpoint store. Resume via BullMQ re-dispatch.                                                      | Saga-style rollback on mid-loop failure; verification of resume from interrupted BullMQ job under crash conditions     |
| [ADR-006](ADRs/ADR-006-agent-memory-architecture.md)          | Agent Memory Architecture                      | Partially Implemented | RAG indexing and retrieval implemented (EmbeddingService, RagIndexService, RagRetrievalService, KnowledgeChunk). Episodic memory and memory MCP tools are stubs.    | Episodic memory (`remember`/`recall` tools backed by a DB table); memory MCP server fully implemented (beyond stubs)   |
| [ADR-007](ADRs/ADR-007-shared-company-storage.md)             | Shared Company Storage                         | Partially Implemented | MinIO in Docker Compose. Storage MCP server (lcp-mcp-storage) implemented with list/read/write/delete/describe tools. `finished/` folder added to bucket structure. | MinIO OIDC SSO (Keycloak console login); `finished/` promotion tooling; audit log export to MinIO JSONL                |
| [ADR-008](ADRs/ADR-008-audit-logging.md)                      | Audit Logging                                  | Partially Implemented | `audit_event` table created; `AuditEvent` writes on LLM request/response, tool calls, and state changes.                                                            | Export audit events to MinIO JSONL (archival path); agent `log_decision` MCP tool; audit log query/filter API          |
| [ADR-009](ADRs/ADR-009-containerization-strategy.md)          | Containerization Strategy                      | Partially Implemented | Full Docker Compose stack. MCP servers run as Docker Compose services (lcp-mcp-storage, lcp-mcp-memory, lcp-mcp-interactions) — supersedes child-process approach.  | Additional per-company/role MCP servers (git, CI/CD tools etc.); per-company stacks if tenancy isolation is required   |
| [ADR-010](ADRs/ADR-010-orchestration-design.md)               | Orchestration Design                           | Partially Implemented | BullMQ `agent-jobs` queue wired. lcp-server enqueues; lcp-agent `AgentWorkerService` consumes. MCP tools wired via McpClientService.                                | `Task` + `TaskStep` entities; planner role agent; multi-step plan execution; agent-to-agent consultation; task review  |
| [ADR-011](ADRs/ADR-011-authentication-authorization.md)       | Authentication and Authorization               | Accepted              | `JwtStrategy` + `JwtAuthGuard` wired. Guards not yet applied to any endpoint. User/CompanyMembership entities pending.                                              | Apply `JwtAuthGuard` to all API endpoints; `User` and `CompanyMembership` entities; role-based access scoping          |
| [ADR-012](ADRs/ADR-012-human-in-the-loop.md)                  | Human-in-the-Loop and User-Agent Conversations | Proposed              | Interactions MCP server stub implemented; `request_user_input` and `request_agent_consultation` return "not yet implemented".                                       | `Conversation` entity; `user_input_requested` SSE event; LangGraph `interrupt()` for agent suspension and resumption   |
| [ADR-013](ADRs/ADR-013-prompt-assembly-context-management.md) | Agent Prompt Assembly and Context Management   | Partially Implemented | 7 of 8 prompt parts implemented (0–5, 8). Context budget + compaction + MinIO overflow implemented. Part 6 (pre-fetched MCP) deferred.                              | Prompt part 6 (pre-fetched MCP responses); essential-information anchoring before `drop_messages`; per-role thresholds |

### Status definitions

| Status                    | Meaning                                         |
| ------------------------- | ----------------------------------------------- |
| **Proposed**              | Decision documented; not yet built              |
| **Accepted**              | Decision reviewed and confirmed; ready to build |
| **Partially Implemented** | Work in progress; some components built         |
| **Implemented**           | Fully built and in use                          |
| **Superseded**            | Replaced by a later ADR                         |

## Features

In-depth guides for implemented system features.

| Document                                    | Description                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| [Agent Services](agent-services.md)         | RAG setup, MCP servers, CLI commands, and MinIO storage layout              |
| [Context Management](context-management.md) | Context window budgeting, compaction strategies, and SSE progress reporting |

## Reference

| Document                   | Description                                                     |
| -------------------------- | --------------------------------------------------------------- |
| [licenses.md](licenses.md) | Dependency license report — auto-generated, do not edit by hand |

## Planning

Historical planning documents and session prompts are in [prompts/](prompts/).

> [!NOTE]
> These are records of how the project was designed, not active documentation.
