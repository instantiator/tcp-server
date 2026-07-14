# ADR-009: Containerization Strategy

Status: Partially Implemented

## Context

LCP must be deployable on any server. Docker Compose is the natural deployment unit. The question is what the containerization _boundary_ should be — how finely to split services across containers, particularly for agents.

## Options

| Strategy                                           | Isolation                                                                | Resource overhead                      | Complexity                            | Notes                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Per-agent container**                            | Highest — each agent run is a fresh container                            | High — container startup per task step | High — dynamic Compose/k8s required   | Useful if agents need different runtimes or package sets; overkill for the current design |
| **Per-company Docker Compose stack**               | Company-level — each company runs its own service set                    | Medium — one full stack per company    | Medium — Compose template per company | Good isolation; complex to provision dynamically; appropriate at larger scale             |
| **Single Docker Compose stack, logical isolation** | Low — all companies share services; isolation by DB row and MinIO bucket | Low — one stack total                  | Low — a single `docker-compose.yml`   | Good starting point; revisit when multi-tenancy or strong isolation is required           |

## Decision

**Single Docker Compose stack with logical per-company isolation.**

All companies share the same PostgreSQL, MinIO, Redis, lcp-server, and lcp-agent instances. Per-company isolation is enforced logically:

- Every DB query is scoped by `company_id`
- Each company has its own MinIO bucket (see [ADR-007](./ADR-007-shared-company-storage.md))
- Memory and knowledge base vectors are namespaced by `{company_id}/{role_name}` (see [ADR-006](./ADR-006-agent-memory-architecture.md))

### Docker Compose services

```
services:
  lcp-server:             NestJS API + orchestration
  lcp-agent:              LangGraph agent loop runner
  lcp-mcp-storage:        Storage MCP server (MinIO tools) — port 3010
  lcp-mcp-memory:         Memory/RAG MCP server — port 3011
  lcp-mcp-interactions:   Interactions MCP server — port 3012
  lcp-mcp-tasks:          Tasks MCP server (added 010.2.5) — port 3013
  postgres:               PostgreSQL 16 + pgvector (pgvector/pgvector image)
  minio:                  MinIO object storage (minio/minio image)
  redis:                  Redis 7 (BullMQ queue backend)
```

### MCP server lifecycle

MCP servers run as **permanent Docker Compose services**, not as child processes. This supersedes the original ADR decision to spawn them on-demand as stdio child processes. The Docker Compose approach provides:

- Independent health checks and restart policies per MCP server
- Clean network isolation (internal Docker network, no host-port exposure required)
- Faster agent startup (no process spawn per task)
- Easier debugging via `docker compose logs`

lcp-agent connects to MCP servers over HTTP using the MCP Streamable HTTP transport. The `McpClientService` resolves server URLs from `MCP_{NAME}_URL` environment variables set in Docker Compose. Tool loading is per-agent-run, scoped to the server names listed in `role.mcpServerList`.

The three standard LCP MCP servers (storage, memory, interactions) are NestJS applications in `apps/lcp-mcp-*/` using `@modelcontextprotocol/sdk`. Additional per-company MCP servers are a future extension.

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
