# LCP Server — Documentation

## Operations

Day-to-day guides for running and maintaining the system.

| Document                                     | Description                                                        |
| -------------------------------------------- | ------------------------------------------------------------------ |
| 📄 [lcp-agent](lcp-agent.md)                 | Creating roles, starting agents, model compatibility check         |
| 📄 [Setup Checklist](setup-checklist.md)     | Step-by-step first-time setup from clone to running tests          |
| 📄 [Scripts](scripts.md)                     | All scripts in `scripts/` — purpose, options, and usage examples   |
| 📄 [Testing](testing.md)                     | Testing strategy, four-tier overview, and how to run each suite    |
| 📄 [Manual Testing](manual-testing/start.md) | Structured manual test guide — infrastructure through MCP servers  |
| 📄 [Services](services.md)                   | All Docker Compose services — ports, dependencies, and purpose     |
| 📄 [Shared Storage](shared-storage.md)       | MinIO authentication, folder structure, and document management    |
| 📄 [Database Migrations](db-migrations.md)   | How to create, register, and run TypeORM migrations                |
| 📄 [Keycloak Setup](keycloak-setup.md)       | Configuring the OIDC provider for local development and production |

## Architecture Decision Records

Design decisions made during the project, with context and rationale.

| ADR                                                           | Title                                          | Status                | Notes                                                                                                                                                                                                                                                                                 | Outstanding                                                                                                            |
| ------------------------------------------------------------- | ---------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [ADR-001](ADRs/ADR-001-service-architecture.md)               | Service Architecture                           | Partially Implemented | Monorepo confirmed. lcp-agent has a working BullMQ worker, LangGraph agent loop, RAG retrieval, and MCP tool node.                                                                                                                                                                    | Anthropic LLM provider; auth guards applied to API endpoints; `Task` entity and task lifecycle                         |
| [ADR-002](ADRs/ADR-002-agent-loop-framework.md)               | Agent Loop Framework                           | Partially Implemented | LangGraph `StateGraph` with PostgreSQL checkpoint store, RAG injection, and conditional MCP `ToolNode`. Anthropic provider deferred. Configurable run limits via `runConfig` on role/company (env-var fallback). LLM retry + structured fallback for summary generation. Reasoning-model quirks (narrated-but-not-invoked tool calls, premature stops) handled by `ReasoningContentRecovery`'s nudge-and-retry, replacing the earlier direct `reasoning_content` promotion.            | Anthropic provider; prompt part 6 (pre-fetched MCP responses); multi-agent coordination graph (planner + workers)      |
| [ADR-003](ADRs/ADR-003-llm-provider-abstraction.md)           | LLM Provider Abstraction                       | Partially Implemented | `buildChatModel` factory for `lm-studio` and `openai` providers. Anthropic provider deferred.                                                                                                                                                                                         | Anthropic provider (`claude-*` models; no `/v1/embeddings` — requires separate `embeddingConfig`)                      |
| [ADR-004](ADRs/ADR-004-database-strategy.md)                  | Database Strategy                              | Partially Implemented | PostgreSQL + pgvector wired. `KnowledgeChunk` entity uses vector columns with IVFFlat index for RAG retrieval.                                                                                                                                                                        | IVFFlat index requires ≥1000 rows before it outperforms a sequential scan; no action needed until data volume grows    |
| [ADR-005](ADRs/ADR-005-agent-state-persistence.md)            | Agent State Persistence and Resumability       | Partially Implemented | `LcpAgent` entity with `status` and `threadId`. PostgresSaver checkpoint store. Resume via BullMQ re-dispatch.                                                                                                                                                                        | Saga-style rollback on mid-loop failure; verification of resume from interrupted BullMQ job under crash conditions     |
| [ADR-006](ADRs/ADR-006-agent-memory-architecture.md)          | Agent Memory Architecture                      | Partially Implemented | `EpisodicMemory` entity + table. lcp-mcp-memory fully implemented: `recall` (hybrid search), `remember` (write), `search_knowledge`. All backed by pgvector.                                                                                                                          | Memory consolidation; memory scrubbing API; `update_rag_context` / `condense_rag_context` MCP tools                    |
| [ADR-007](ADRs/ADR-007-shared-company-storage.md)             | Shared Company Storage                         | Partially Implemented | lcp-mcp-storage: 12 tools (list, read, write, delete, restore, search, properties, copy, move, summary, describe_server, describe_folder). Soft delete, overwrite guard, audit logging.                                                                                               | MinIO OIDC SSO; audit log JSONL export; MinIO bucket versioning                                                        |
| [ADR-008](ADRs/ADR-008-audit-logging.md)                      | Audit Logging                                  | Partially Implemented | HTTP audit endpoint (`POST /internal/audit`). `AuditClientService` used by all services. All MCP tool calls write `tool_call`/`tool_result` events. `complete_task` replaces `log_decision`.                                                                                          | Export to MinIO JSONL; audit query/filter API; retention policy                                                        |
| [ADR-009](ADRs/ADR-009-containerization-strategy.md)          | Containerization Strategy                      | Partially Implemented | Full Docker Compose stack. MCP servers run as Docker Compose services (lcp-mcp-storage, lcp-mcp-memory, lcp-mcp-interactions) — supersedes child-process approach. `scripts/start-deployment.sh` provides a generalised launcher for dev, CI, and future environment targets.         | Additional per-company/role MCP servers (git, CI/CD tools etc.); per-company stacks if tenancy isolation is required   |
| [ADR-010](ADRs/ADR-010-orchestration-design.md)               | Orchestration Design                           | Partially Implemented | BullMQ `agent-jobs` queue wired. lcp-server enqueues; lcp-agent `AgentWorkerService` consumes. MCP tools wired via McpClientService, which auto-injects each call's `agentId`/`companyId` server-side and strips them from the LLM-visible tool schema so the calling model can't spoof its own identity.       | `Task` + `TaskStep` entities; planner role agent; multi-step plan execution; task review                               |
| [ADR-011](ADRs/ADR-011-authentication-authorization.md)       | Authentication and Authorization               | Partially Implemented | `JwtStrategy` + `JwtAuthGuard` wired. `CompanyUser` entity implements a simplified membership model (no permission flags yet). `@RequirePermission()` no-op decorator in place.                                                                                                       | Apply `JwtAuthGuard` to all endpoints; full `CompanyMembership` permission flag system; Keycloak user proxy endpoints  |
| [ADR-012](ADRs/ADR-012-human-in-the-loop.md)                  | Human-in-the-Loop and User-Agent Conversations | Partially Implemented | `Conversation`, `ConversationMessage`, `PendingConsultation` entities. `request_user_input`, `request_agent_consultation`, `complete_task` fully implemented. BullMQ-based pause/resume (not LangGraph `interrupt()`). Consultations target a role by `roleId` (unambiguous even when role names collide within a company); `request_user_input` can target specific `userIds`. Resume is gated on zero outstanding consultations/conversations and aggregates every response received since `pausedAt` into one resume message. | User-initiated conversations; WebSocket upgrade; teaching flow; SSE audit stream                                       |
| [ADR-013](ADRs/ADR-013-prompt-assembly-context-management.md) | Agent Prompt Assembly and Context Management   | Partially Implemented | 7 of 8 prompt parts implemented (0–5, 8). Context budget + compaction + MinIO overflow implemented. Part 6 (pre-fetched MCP) deferred.                                                                                                                                                | Prompt part 6 (pre-fetched MCP responses); essential-information anchoring before `drop_messages`; per-role thresholds |
| [ADR-014](ADRs/ADR-014-swagger-endpoints.md)                  | API Documentation (Swagger / OpenAPI)          | Implemented           | `@nestjs/swagger` v11 installed. `GET /swagger` (UI) and `GET /swagger-json` (spec) on all five server apps. CLI plugin enabled in `nest-cli.json`. `@ApiTags` / `@ApiOperation` decorators on all lcp-server controllers. `lcp-cli open-swagger` command added. Smoke tests updated. | —                                                                                                                      |
| [ADR-015](ADRs/ADR-015-agent-completion-sse.md)               | Agent Completion via SSE Instead of Long-Poll  | Proposed              | —                                                                                                                                                                                                                                                                                     | Replace `waitForAgentCompletion` long-poll with `202` + SSE `completed` event; add `LcpAgent.completionMessage` column |

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

| Document                                          | Description                                                                   |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| [Agent Services](agent-services.md)               | RAG setup, MCP servers, CLI commands, and MinIO storage layout                |
| [lcp-mcp-storage](lcp-mcp-storage.md)             | Storage MCP server — full tool reference (12 tools, soft delete, audit)       |
| [lcp-mcp-memory](lcp-mcp-memory.md)               | Memory MCP server — real implementation with pgvector recall and remember     |
| [lcp-mcp-interactions](lcp-mcp-interactions.md)   | Interactions MCP server — pause/resume, consultation, complete_task           |
| [User Input Conversations](user-input-conversations.md) | Agent-to-human flow — query routing, pause/resume, sequence diagrams    |
| [Cross-Agent Consultations](cross-agent-consultations.md) | Agent-to-agent flow — role lookup by id, resume conditions, sequence diagram |
| [Queue](queue.md)                                 | BullMQ `agent-jobs` queue — job types, use cases, and sequence diagrams       |
| [Context Management](context-management.md)       | Context window budgeting, compaction strategies, and SSE progress reporting   |
| [Agent Special Cases](lcp-agent-special-cases.md) | LLM provider quirks (e.g. reasoning_content) and where their workarounds live |

## Reference

| Document                   | Description                                                                   |
| -------------------------- | ----------------------------------------------------------------------------- |
| [glossary.md](glossary.md) | Definitions for all core terms — entities, services, execution, MCP, storage  |
| [schema.md](schema.md)     | JSON Schema reference — entity schemas, DTO field tables, validation examples |
| [licenses.md](licenses.md) | Dependency license report — auto-generated, do not edit by hand               |

## Planning

Historical planning documents and session prompts are in [prompts/](prompts/).

> [!NOTE]
> These are records of how the project was designed, not active documentation.
