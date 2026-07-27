# ADR-001: Service Architecture

Status: Partially Implemented (amended — see [Amendment](#amendment-as-implemented-01029) at the end)

## Context

TCP currently exists as a single NestJS service (`tcp-server`) that manages company entities. As the system grows to include LLM agent loops, orchestration, memory, and shared storage, a decision is needed about how responsibilities are distributed across deployable services.

The core tension is between simplicity (everything in one process) and isolation (agent loops that can hang, crash, or run for hours should not affect the HTTP API).

## Options

| Option                 | Description                                                                      | Pros                                                                                               | Cons                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Monolith**           | Agent loops run as background workers inside `tcp-server`                        | Single repo; shared DB access; no inter-service comms                                              | Hung agent loop blocks or degrades the API; cannot scale agent execution independently |
| **Two services**       | `tcp-server` (API + orchestration state) + `tcp-agent` (agent loop runner)       | Independent scaling; agent crashes don't affect the API; tcp-agent runnable standalone for testing | Inter-service communication required                                                   |
| **Many microservices** | Separate service per concern (orchestrator, storage, memory, agent runner, etc.) | Maximum isolation; independent deployment                                                          | Premature complexity for current scale; large operational overhead                     |

## Decision

**Two services**: `tcp-server` and `tcp-agent`.

### tcp-server responsibilities

- REST API (company management, task submission, user-agent conversations)
- Orchestration state machine (task lifecycle, plan management, step dispatch)
- Database access (PostgreSQL — see [ADR-004](./ADR-004-database-strategy.md))
- Task queue dispatch (via BullMQ — see [ADR-010](./ADR-010-orchestration-design.md))
- Authentication and authorisation (see [ADR-011](./ADR-011-authentication-authorization.md))

### tcp-agent responsibilities

- Executes the LLM agent loop for a given task step
- Manages MCP server lifecycle for the duration of a step
- Reads role config (prompts, LLM settings, MCP server list) from the task payload
- Reports progress and results back to tcp-server via the task queue
- Persists LangGraph checkpoints to PostgreSQL for resumability (see [ADR-005](./ADR-005-agent-state-persistence.md))

### Communication between services

tcp-server dispatches jobs to tcp-agent via BullMQ (Redis-backed). tcp-agent publishes result and progress events back to the same queue. Both services share the same PostgreSQL instance. Internal network trust within Docker Compose — no auth between services (see [ADR-009](./ADR-009-containerization-strategy.md)).

### Standalone operation

tcp-agent must be runnable in isolation without tcp-server, to support:

- Testing individual agent roles against a given prompt
- Development of new roles
- Debugging stuck or failed agent runs

When run standalone, tcp-agent accepts a task payload directly (JSON file or env vars) rather than polling a queue.

## Company data structure

The `TcpCompany` entity will be extended to include:

- **User list** with per-user permissions (see [ADR-011](./ADR-011-authentication-authorization.md))
- **Planner role** — the role responsible for generating task plans from user prompts (see [ADR-010](./ADR-010-orchestration-design.md))
- **MCP server list** — additional MCP servers available company-wide (beyond the standard set)
- **Role definitions** — list of agent roles the company uses (see [ADR-010](./ADR-010-orchestration-design.md))

## Consequences

- Two repositories or a monorepo with two packages — decision deferred; start in the same repo as `packages/tcp-agent`
- Docker Compose is the deployment unit for both services together (see [ADR-009](./ADR-009-containerization-strategy.md))
- The existing `tcp-server` codebase is the starting point; tcp-agent is a new package

## Open Questions / Assumptions

- Monorepo structure (npm workspaces or NX) vs. separate repositories — defer until tcp-agent scaffolding begins
- Whether the BullMQ queue needs a dead-letter queue for failed agent jobs — note for ADR-010

## Amendment as implemented (010.2.9)

The decision above ("Two services") undersold what was actually built. As implemented:

- **A third tier of services exists.** Each MCP server — `tcp-mcp-storage`, `tcp-mcp-memory`, `tcp-mcp-interactions`, and (since 010.2.5) `tcp-mcp-tasks` — is its own NestJS app and its own Docker Compose service, not folded into `tcp-server` or `tcp-agent`. This is closer to the rejected "Many microservices" option than to "Two services," but adopted only for the agent-tool surface (where MCP's HTTP-server-per-tool-provider shape made a dedicated app the natural fit), not as a general decomposition — `tcp-server` still owns all REST API and orchestration state, and `tcp-agent` still owns the agent loop. See [ADR-009](./ADR-009-containerization-strategy.md) for the containerization side of this.
- **"No auth between services" is no longer true.** `INTERNAL_API_KEY` (`X-Internal-Api-Key` header) is required on every internal service-to-service call, enforced by `InternalApiKeyGuard` (`@tcp/shared`). Trust within the Docker network is still assumed (the key is a shared secret, not per-service identity), but it's not the "no auth" originally decided.
- **The `Task` entity and task lifecycle are no longer outstanding.** `TcpTask`/`TcpAssignment` entities, a full REST API, CLI verbs, and a sequential orchestration state machine (`TaskOrchestrationService`) are implemented — see [ADR-010](./ADR-010-orchestration-design.md).
