# ADR-009: Containerization Strategy

Status: Proposed

## Context

LCP must be deployable on any server. Docker Compose is the natural deployment unit. The question is what the containerization *boundary* should be — how finely to split services across containers, particularly for agents.

## Options

| Strategy | Isolation | Resource overhead | Complexity | Notes |
|----------|-----------|------------------|------------|-------|
| **Per-agent container** | Highest — each agent run is a fresh container | High — container startup per task step | High — dynamic Compose/k8s required | Useful if agents need different runtimes or package sets; overkill for the current design |
| **Per-company Docker Compose stack** | Company-level — each company runs its own service set | Medium — one full stack per company | Medium — Compose template per company | Good isolation; complex to provision dynamically; appropriate at larger scale |
| **Single Docker Compose stack, logical isolation** | Low — all companies share services; isolation by DB row and MinIO bucket | Low — one stack total | Low — a single `docker-compose.yml` | Good starting point; revisit when multi-tenancy or strong isolation is required |

## Decision

**Single Docker Compose stack with logical per-company isolation.**

All companies share the same PostgreSQL, MinIO, Redis, lcp-server, and lcp-agent instances. Per-company isolation is enforced logically:
- Every DB query is scoped by `company_id`
- Each company has its own MinIO bucket (see [ADR-007](./ADR-007-shared-company-storage.md))
- Memory and knowledge base vectors are namespaced by `{company_id}/{role_name}` (see [ADR-006](./ADR-006-agent-memory-architecture.md))

### Docker Compose services

```
services:
  lcp-server:    NestJS API + orchestration
  lcp-agent:     LangGraph agent loop runner
  postgres:      PostgreSQL 16 + pgvector (pgvector/pgvector image)
  minio:         MinIO object storage (minio/minio image)
  redis:         Redis 7 (BullMQ queue backend)
```

### MCP server lifecycle

MCP servers are **not** permanent Docker services. They are spawned on-demand by lcp-agent at the start of each task step and torn down on completion. This keeps the Compose file simple and avoids running idle MCP processes.

The three standard LCP MCP servers (memory, storage, audit-decision — see [ADR-006](./ADR-006-agent-memory-architecture.md), [ADR-007](./ADR-007-shared-company-storage.md), [ADR-008](./ADR-008-audit-logging.md)) are Node.js processes spawned as child processes of lcp-agent using the MCP stdio transport.

Additional per-company and per-role MCP servers (git, CI/CD, design tools, etc.) are configured in the company/role definition and spawned the same way.

### Revisit trigger

Move to per-company stacks when any of the following occurs:
- Strong data isolation between tenants is a legal or contractual requirement
- A single company's agent workload saturates shared resources
- Different companies need different versions of a service

## Consequences

- A single `docker-compose.yml` (plus a `.env` for secrets) is all that's needed to run LCP
- Adding a new company does not require infrastructure changes — only a new DB row and MinIO bucket
- MCP servers with long startup times (e.g., ones that load large models) may benefit from being long-lived per-company; this is an optimisation to consider on a case-by-case basis

## Open Questions / Assumptions

- lcp-agent's concurrency is controlled by BullMQ worker concurrency config — set conservatively to avoid overloading the LLM provider API or local LM Studio instance
- Health checks and restart policies for all services should be defined in the Compose file
