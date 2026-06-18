# ADR-001: Service Architecture

Status: Proposed

## Context

LCP currently exists as a single NestJS service (`lcp-server`) that manages company entities. As the system grows to include LLM agent loops, orchestration, memory, and shared storage, a decision is needed about how responsibilities are distributed across deployable services.

The core tension is between simplicity (everything in one process) and isolation (agent loops that can hang, crash, or run for hours should not affect the HTTP API).

## Options

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **Monolith** | Agent loops run as background workers inside `lcp-server` | Single repo; shared DB access; no inter-service comms | Hung agent loop blocks or degrades the API; cannot scale agent execution independently |
| **Two services** | `lcp-server` (API + orchestration state) + `lcp-agent` (agent loop runner) | Independent scaling; agent crashes don't affect the API; lcp-agent runnable standalone for testing | Inter-service communication required |
| **Many microservices** | Separate service per concern (orchestrator, storage, memory, agent runner, etc.) | Maximum isolation; independent deployment | Premature complexity for current scale; large operational overhead |

## Decision

**Two services**: `lcp-server` and `lcp-agent`.

### lcp-server responsibilities
- REST API (company management, task submission, user-agent conversations)
- Orchestration state machine (task lifecycle, plan management, step dispatch)
- Database access (PostgreSQL — see [ADR-004](./ADR-004-database-strategy.md))
- Task queue dispatch (via BullMQ — see [ADR-010](./ADR-010-orchestration-design.md))
- Authentication and authorisation (see [ADR-011](./ADR-011-authentication-authorization.md))

### lcp-agent responsibilities
- Executes the LLM agent loop for a given task step
- Manages MCP server lifecycle for the duration of a step
- Reads role config (prompts, LLM settings, MCP server list) from the task payload
- Reports progress and results back to lcp-server via the task queue
- Persists LangGraph checkpoints to PostgreSQL for resumability (see [ADR-005](./ADR-005-agent-state-persistence.md))

### Communication between services

lcp-server dispatches jobs to lcp-agent via BullMQ (Redis-backed). lcp-agent publishes result and progress events back to the same queue. Both services share the same PostgreSQL instance. Internal network trust within Docker Compose — no auth between services (see [ADR-009](./ADR-009-containerization-strategy.md)).

### Standalone operation

lcp-agent must be runnable in isolation without lcp-server, to support:
- Testing individual agent roles against a given prompt
- Development of new roles
- Debugging stuck or failed agent runs

When run standalone, lcp-agent accepts a task payload directly (JSON file or env vars) rather than polling a queue.

## Company data structure

The `LcpCompany` entity will be extended to include:
- **User list** with per-user permissions (see [ADR-011](./ADR-011-authentication-authorization.md))
- **Planner role** — the role responsible for generating task plans from user prompts (see [ADR-010](./ADR-010-orchestration-design.md))
- **MCP server list** — additional MCP servers available company-wide (beyond the standard set)
- **Role definitions** — list of agent roles the company uses (see [ADR-010](./ADR-010-orchestration-design.md))

## Consequences

- Two repositories or a monorepo with two packages — decision deferred; start in the same repo as `packages/lcp-agent`
- Docker Compose is the deployment unit for both services together (see [ADR-009](./ADR-009-containerization-strategy.md))
- The existing `lcp-server` codebase is the starting point; lcp-agent is a new package

## Open Questions / Assumptions

- Monorepo structure (npm workspaces or NX) vs. separate repositories — defer until lcp-agent scaffolding begins
- Whether the BullMQ queue needs a dead-letter queue for failed agent jobs — note for ADR-010
