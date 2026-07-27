# Services

All services are defined in `docker-compose.yml`. Zitadel is optional and only
starts when the `auth` profile is active (`docker compose --profile auth up`).

## Summary

| Service              | Container name         | Exposed ports              | Description                                           |
| -------------------- | ---------------------- | -------------------------- | ----------------------------------------------------- |
| tcp-server           | `tcp-server`           | 3000                       | REST API and orchestration layer                      |
| tcp-agent            | `tcp-agent`            | 3001                       | Agent loop runner                                     |
| tcp-mcp-storage      | `tcp-mcp-storage`      | 3010                       | Storage MCP server (MinIO tools)                      |
| tcp-mcp-memory       | `tcp-mcp-memory`       | 3011                       | Memory MCP server (stub)                              |
| tcp-mcp-interactions | `tcp-mcp-interactions` | 3012                       | Interactions MCP server (stub)                        |
| PostgreSQL           | `postgres`             | 5432                       | Primary relational store (pgvector extension enabled) |
| Redis                | `redis`                | 6379                       | Task queue broker (BullMQ)                            |
| MinIO                | `minio`                | 9000 (API), 9001 (console) | S3-compatible object storage                          |
| Zitadel              | `zitadel`              | 8080                       | OIDC identity provider (profile: auth)                |

## TCP services

### tcp-server

NestJS REST API. Handles incoming HTTP requests, persists data to PostgreSQL,
enqueues agent tasks via BullMQ, and validates JWT tokens issued by Zitadel.

- **Health:** `GET http://localhost:3000/health` — checks PostgreSQL, MinIO, and OIDC reachability
- **Depends on:** postgres, redis, minio (all must be healthy before startup)
- **Built from:** `apps/tcp-server/Dockerfile`

### tcp-agent

NestJS agent loop runner. Consumes BullMQ jobs from Redis, executes agent steps, and persists results to PostgreSQL and MinIO. Connects to MCP servers over HTTP to load tools for each agent run. See [tcp-agent.md](tcp-agent.md) for configuration and usage.

- **Health:** `GET http://localhost:3001/health`
- **Depends on:** postgres, redis
- **Built from:** `apps/tcp-agent/Dockerfile`

### tcp-mcp-storage

NestJS MCP server providing agents with read/write access to the shared MinIO object store. Uses the MCP Streamable HTTP transport — stateless, one session per request. See [tcp-mcp-storage.md](tcp-mcp-storage.md) for tool reference.

- **Health:** `GET http://localhost:3010/health`
- **API:** `POST http://localhost:3010/mcp` (MCP JSON-RPC)
- **Depends on:** minio
- **Built from:** `apps/tcp-mcp-storage/Dockerfile`

### tcp-mcp-memory

NestJS MCP server for semantic search over episodic memory and role knowledge. Currently a stub — all tools return informative "not yet implemented" responses. See [tcp-mcp-memory.md](tcp-mcp-memory.md) for tool reference and planned implementation.

- **Health:** `GET http://localhost:3011/health`
- **API:** `POST http://localhost:3011/mcp`
- **Built from:** `apps/tcp-mcp-memory/Dockerfile`

### tcp-mcp-interactions

NestJS MCP server for requesting input from human users or consulting other agents by role. Currently a stub. See [tcp-mcp-interactions.md](tcp-mcp-interactions.md) for tool reference and planned implementation.

- **Health:** `GET http://localhost:3012/health`
- **API:** `POST http://localhost:3012/mcp`
- **Built from:** `apps/tcp-mcp-interactions/Dockerfile`

## Third-party services

### PostgreSQL

Image: `pgvector/pgvector:pg16`

The pgvector variant of PostgreSQL 16. The `pgvector` extension enables
vector similarity search, used for agent memory retrieval (see
[ADR-006](ADRs/ADR-006-agent-memory-architecture.md)).

On first startup an init script at `docker/postgres-init/create-databases.sh`
creates a second database (`zitadel`) alongside the default `tcp` database.

- **Credentials:** `POSTGRES_USER=tcp`, password from `POSTGRES_PASSWORD` in `.env`
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

### Zitadel _(profile: auth)_

Image: `ghcr.io/zitadel/zitadel:v4.16.1` (pinned, not `:latest`)

OIDC identity provider. Issues JWT tokens that tcp-server validates on
guarded endpoints. Runs its classic embedded login (no separate Login V2
container or reverse proxy) — suitable for local development only.

Zitadel shares the `postgres` container, storing its own configuration in a
`zitadel` logical database created by `docker/postgres-init/create-databases.sh`.

- **Admin console:** `http://localhost:8080/ui/console` — username `admin`, password from `ZITADEL_ADMIN_PASSWORD`
- **OIDC discovery:** `http://localhost:8080/.well-known/openid-configuration`
- **Depends on:** postgres (must be healthy)
- **Setup:** see [docs/zitadel-setup.md](zitadel-setup.md)

> **Note:** the healthcheck runs `["CMD", "/app/zitadel", "ready"]`, not curl —
> the image is a minimal single static Go binary with no shell or curl
> installed. It also needs `ZITADEL_TLS_ENABLED: 'false'` set explicitly: this
> is a separate env var from the `--tlsMode disabled` start flag, which only
> applies to the main server process, not the separate `zitadel ready` CLI
> invocation the healthcheck uses. Without it, `zitadel ready` defaults to
> HTTPS and fails against the plain-HTTP server, leaving the container stuck
> "unhealthy" forever.
