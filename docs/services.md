# Services

All services are defined in `docker-compose.yml`. Keycloak is optional and only
starts when the `auth` profile is active (`docker compose --profile auth up`).

## Summary

| Service              | Container name         | Exposed ports              | Description                                           |
| -------------------- | ---------------------- | -------------------------- | ----------------------------------------------------- |
| lcp-server           | `lcp-server`           | 3000                       | REST API and orchestration layer                      |
| lcp-agent            | `lcp-agent`            | 3001                       | Agent loop runner                                     |
| lcp-mcp-storage      | `lcp-mcp-storage`      | 3010                       | Storage MCP server (MinIO tools)                      |
| lcp-mcp-memory       | `lcp-mcp-memory`       | 3011                       | Memory MCP server (stub)                              |
| lcp-mcp-interactions | `lcp-mcp-interactions` | 3012                       | Interactions MCP server (stub)                        |
| PostgreSQL           | `postgres`             | 5432                       | Primary relational store (pgvector extension enabled) |
| Redis                | `redis`                | 6379                       | Task queue broker (BullMQ)                            |
| MinIO                | `minio`                | 9000 (API), 9001 (console) | S3-compatible object storage                          |
| Keycloak             | `keycloak`             | 8080                       | OIDC identity provider (profile: auth)                |

## LCP services

### lcp-server

NestJS REST API. Handles incoming HTTP requests, persists data to PostgreSQL,
enqueues agent tasks via BullMQ, and validates JWT tokens issued by Keycloak.

- **Health:** `GET http://localhost:3000/health` — checks PostgreSQL, MinIO, and OIDC reachability
- **Depends on:** postgres, redis, minio (all must be healthy before startup)
- **Built from:** `apps/lcp-server/Dockerfile`

### lcp-agent

NestJS agent loop runner. Consumes BullMQ jobs from Redis, executes agent steps, and persists results to PostgreSQL and MinIO. Connects to MCP servers over HTTP to load tools for each agent run. See [lcp-agent.md](lcp-agent.md) for configuration and usage.

- **Health:** `GET http://localhost:3001/health`
- **Depends on:** postgres, redis
- **Built from:** `apps/lcp-agent/Dockerfile`

### lcp-mcp-storage

NestJS MCP server providing agents with read/write access to the shared MinIO object store. Uses the MCP Streamable HTTP transport — stateless, one session per request. See [lcp-mcp-storage.md](lcp-mcp-storage.md) for tool reference.

- **Health:** `GET http://localhost:3010/health`
- **API:** `POST http://localhost:3010/mcp` (MCP JSON-RPC)
- **Depends on:** minio
- **Built from:** `apps/lcp-mcp-storage/Dockerfile`

### lcp-mcp-memory

NestJS MCP server for semantic search over episodic memory and role knowledge. Currently a stub — all tools return informative "not yet implemented" responses. See [lcp-mcp-memory.md](lcp-mcp-memory.md) for tool reference and planned implementation.

- **Health:** `GET http://localhost:3011/health`
- **API:** `POST http://localhost:3011/mcp`
- **Built from:** `apps/lcp-mcp-memory/Dockerfile`

### lcp-mcp-interactions

NestJS MCP server for requesting input from human users or consulting other agents by role. Currently a stub. See [lcp-mcp-interactions.md](lcp-mcp-interactions.md) for tool reference and planned implementation.

- **Health:** `GET http://localhost:3012/health`
- **API:** `POST http://localhost:3012/mcp`
- **Built from:** `apps/lcp-mcp-interactions/Dockerfile`

## Third-party services

### PostgreSQL

Image: `pgvector/pgvector:pg16`

The pgvector variant of PostgreSQL 16. The `pgvector` extension enables
vector similarity search, used for agent memory retrieval (see
[ADR-006](ADRs/ADR-006-agent-memory-architecture.md)).

On first startup an init script at `docker/postgres-init/create-databases.sh`
creates a second database (`keycloak`) alongside the default `lcp` database.

- **Credentials:** `POSTGRES_USER=lcp`, password from `POSTGRES_PASSWORD` in `.env`
- **Persistent volume:** `postgres_data`

### Redis

Image: `redis:7-alpine`

Broker for BullMQ task queues. Runs with `--appendonly yes` so the queue
survives container restarts.

- **Persistent volume:** `redis_data`

### MinIO

Image: `minio/minio:latest`

S3-compatible object storage for agent artefacts (uploaded files, generated
documents). The web console at port 9001 is useful for inspecting bucket
contents during development.

- **Credentials:** `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` from `.env`
- **Persistent volume:** `minio_data`

### Keycloak _(profile: auth)_

Image: `quay.io/keycloak/keycloak:latest`

OIDC identity provider. Issues JWT tokens that lcp-server validates on
guarded endpoints. Runs in `start-dev` mode (no TLS, single-node) — suitable
for local development only.

Keycloak stores its own configuration in the `keycloak` PostgreSQL database.
The management port (9000) is used internally for health checks; it is not
exposed to the host.

- **Admin console:** `http://localhost:8080` — username `admin`, password from `KEYCLOAK_ADMIN_PASSWORD`
- **Realm OIDC discovery:** `http://localhost:8080/realms/lcp/.well-known/openid-configuration`
- **Depends on:** postgres (must be healthy)
- **Setup:** see [docs/keycloak-setup.md](keycloak-setup.md)

> **Note:** Keycloak 24+ serves `/health/ready` on the management port (9000),
> not on the main port (8080). Scripts and health checks use the master realm
> OIDC discovery URL on port 8080 instead, which is always available.
