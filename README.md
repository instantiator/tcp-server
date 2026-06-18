# Little Computer People (LCP) Server

LCP manages one or more companies of AI agents that collaborate to complete tasks.

## Companies

A company consists of several specialists or generalists, each provided with:

- Overview of the organisation
- Identity prompt
- Reference material
- Personal knowledge database
- Access to tools
- Membership of a group where they can initiate conversations with other agents

## Tasks

Tasks are given to the company, who then work collaboratively to resolve them. A planner agent creates a plan incorporating knowledge of the company's roles and their skills. Each plan step is assigned to an agent role that executes it and reports back.

## System architecture

```mermaid
graph TD
  User["User / Browser"] -->|REST API :3000| LcpServer["lcp-server\n(NestJS)"]
  LcpServer -->|OIDC token\nvalidation| Keycloak["Keycloak :8080\n(optional --profile auth)"]
  LcpServer -->|TypeORM| Postgres[(PostgreSQL\n+ pgvector :5432)]
  LcpServer -->|BullMQ jobs| Redis[(Redis :6379)]
  LcpServer -->|S3 API| MinIO[(MinIO :9000\nconsole :9001)]
  LcpAgent["lcp-agent\n(NestJS) :3001"] -->|BullMQ results| Redis
  LcpAgent -->|TypeORM| Postgres
  LcpAgent -->|S3 API| MinIO
  LcpAgent -->|stdio| MCP["MCP Servers\n(child processes)"]
```

Key architectural decisions are documented as ADRs in [docs/ADRs/](docs/ADRs/). See [docs/ADRs/IMPLEMENTATION-STATUS.md](docs/ADRs/IMPLEMENTATION-STATUS.md) for current implementation status.

## Getting started

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/)
- [Node.js 24](https://nodejs.org/) and npm

### First-time setup

```bash
# Clone the repo (with the dev-environment submodule)
git clone --recurse-submodules <repo-url>
cd lcp-server

# Copy environment variables and edit as needed
cp .env.example .env

# Install dependencies
npm install
```

### Start everything

```bash
# Start all infrastructure services + LCP apps
docker compose up

# With Keycloak for authentication (optional):
docker compose --profile auth up
```

Services will be available at:

| Service | URL |
|---------|-----|
| lcp-server API | http://localhost:3000 |
| lcp-server health | http://localhost:3000/health |
| lcp-agent health | http://localhost:3001/health |
| MinIO console | http://localhost:9001 |
| Keycloak admin | http://localhost:8080 (profile: auth) |

### Stop everything

```bash
docker compose down          # stop, keep volumes
docker compose down -v       # stop + remove volumes (resets all data)
```

### Local development (without Docker)

```bash
# Start infrastructure only
docker compose up postgres redis minio

# Run lcp-server with hot reload
npm run start:dev
```

lcp-server falls back to in-memory SQLite when `DATABASE_URL` is not a postgres URL — convenient for quick iteration without Docker.

## Testing

| Command | What it tests | Requires |
|---------|---------------|----------|
| `npm test` | Unit tests (fast, no external services) | Nothing |
| `npm run test:e2e` | HTTP API tests against AppModule | Nothing (SQLite fallback) |
| `npm run test:integration` | Service connectivity checks | Docker Compose |
| `npm run test:system` | Full stack health checks | `docker compose up` |

### Convenience scripts

The `scripts/` directory mirrors the GitHub Actions CI steps — useful for local testing:

```bash
./scripts/run-unit-tests.sh          # unit tests only
./scripts/run-e2e-tests.sh           # starts postgres/redis/minio, runs e2e
./scripts/run-integration-tests.sh  # starts services, runs integration tests
./scripts/run-system-tests.sh       # starts all services, runs system tests
```

### Database migrations

Migrations run automatically on lcp-server startup when `DATABASE_URL` points to PostgreSQL.

To create a new migration after changing an entity:

```bash
DATABASE_URL=postgres://lcp:password@localhost:5432/lcp \
  npm run migration:generate -- apps/lcp-server/src/migrations/MigrationName
```

Review the generated file in `apps/lcp-server/src/migrations/`, then commit it alongside the entity change.

## Authentication

See [docs/keycloak-setup.md](docs/keycloak-setup.md) for Keycloak setup. To use a different OIDC provider, set `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET` in `.env`.

## Technologies

Currently implemented:

| Concern | Choice |
|---------|--------|
| Framework | NestJS 11 |
| ORM | TypeORM |
| Database (production) | PostgreSQL 16 + pgvector |
| Database (unit tests) | better-sqlite3 (in-memory) |
| Auth | OAuth2/OIDC (Keycloak default) |
| Object storage | MinIO |
| Task queue | Redis (BullMQ — configured, workers pending) |
| Schema export | ts-json-schema-generator |

See [docs/ADRs/](docs/ADRs/) for decisions on upcoming components (agent runner, memory, orchestration).

## Commands reference

| Command | Purpose |
|---------|---------|
| `npm run build` | Compile both apps to `dist/` |
| `npm run build lcp-server` | Compile lcp-server only |
| `npm run build lcp-agent` | Compile lcp-agent only |
| `npm run start:dev` | Start lcp-server with hot reload |
| `npm run lint` | ESLint with auto-fix |
| `npm run format` | Prettier over `apps/` and `libs/` |
| `npm test` | Unit tests |
| `npm run test:e2e` | E2E tests |
| `npm run test:integration` | Integration tests (needs Docker) |
| `npm run test:system` | System tests (needs `docker compose up`) |
| `npm run schema:generate` | Regenerate [schemas/schema.json](schemas/schema.json) |
| `npm run licenses:generate` | Regenerate [docs/licenses.md](docs/licenses.md) |
| `npm run migration:generate` | Generate a new TypeORM migration |
| `npm run migration:run` | Run pending migrations |
| `npm run migration:revert` | Revert the last migration |
