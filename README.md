# Little Computer People (LCP) Server

LCP manages one or more companies of AI agents that collaborate to complete tasks.

[![CI](https://github.com/instantiator/lcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/instantiator/lcp-server/actions/workflows/ci.yml)

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

The main service topology — solid borders are implemented, dashed borders are planned but not yet built.

```mermaid
graph TD
  User["User / Browser"] -->|REST API :3000| LcpServer["lcp-server\n(NestJS)"]
  LcpServer -->|OIDC token\nvalidation| Keycloak["Keycloak :8080\n(optional --profile auth)"]
  LcpServer -->|TypeORM| Postgres[(PostgreSQL\n+ pgvector :5432)]
  LcpServer -->|BullMQ jobs| Redis[(Redis :6379)]
  LcpServer -->|S3 API| MinIO[(MinIO :9000\nconsole :9001)]
  LcpAgent["lcp-agent\n(NestJS) :3001"] -->|BullMQ results| Redis
  LcpAgent -->|TypeORM| Postgres
  LcpAgent -->|HTTP /mcp| McpStorage["lcp-mcp-storage\n:3010"]
  LcpAgent -->|HTTP /mcp| McpMemory["lcp-mcp-memory\n:3011\n(stub)"]
  LcpAgent -->|HTTP /mcp| McpInteract["lcp-mcp-interactions\n:3012\n(stub)"]
  McpStorage -->|S3 API| MinIO
  style McpMemory stroke-dasharray: 5 5
  style McpInteract stroke-dasharray: 5 5
```

> Service overview: lcp-server is the REST API and orchestration layer. lcp-agent consumes BullMQ jobs and runs the LangGraph agent loop. Three MCP servers provide tool access to agents: lcp-mcp-storage offers real MinIO file operations; lcp-mcp-memory and lcp-mcp-interactions are currently stubs. PostgreSQL (with pgvector) stores entities, agent checkpoints, and knowledge embeddings. MinIO stores knowledge documents, task files, and context-overflow data. Keycloak is optional and only starts under the `--profile auth` flag.

---

### Agent loop

How a single agent turn flows through the system.

```mermaid
sequenceDiagram
  participant U as User / BullMQ
  participant S as lcp-server / lcp-agent
  participant DB as PostgreSQL
  participant E as Embedding Model
  participant MCP as MCP Servers
  participant LLM as LLM Provider

  U->>S: message or dispatched job
  S->>DB: load LangGraph checkpoint + role/company
  S->>E: embed query → cosine search
  DB-->>S: RAG chunks (prompt part 5)
  S->>MCP: loadTools() for role.mcpServerList
  MCP-->>S: DynamicStructuredTool[]
  S->>LLM: invoke (system + role + company + services + task + RAG)
  LLM-->>S: response or tool_call
  alt tool call
    S->>MCP: callTool(name, args)
    MCP-->>S: result
    S->>LLM: invoke with tool result
    LLM-->>S: final response
  end
  S->>DB: save checkpoint + audit events
  S-->>U: response text
```

> Agent turn flow: the agent receives a message or is dispatched as a background job. The system loads the LangGraph checkpoint (conversation history) from PostgreSQL, retrieves relevant RAG chunks via pgvector, and loads MCP tools for the role. The LLM is invoked with the assembled prompt. If the model requests a tool call, the tool is executed via the appropriate MCP server and the result is fed back. The final response and checkpoint are persisted.

---

### RAG subsystem

How knowledge documents flow from upload to retrieval.

```mermaid
flowchart TD
  subgraph Upload
    CLI[lcp-cli store-role-documents] -->|POST /api/roles/:id/documents| API[lcp-server]
    API -->|store raw file| MinIO2[(MinIO\nknowledge/role_name/)]
    API -->|chunk 800 tokens| Chunker[Chunker]
    Chunker -->|embed /v1/embeddings| Embed[Embedding Model]
    Embed -->|INSERT vector| PG[(pgvector\nknowledge_chunk)]
  end
  subgraph Retrieval
    Query[Agent initial prompt] -->|embed| Embed2[Embedding Model]
    Embed2 -->|cosine similarity ≥ 0.7| PG
    PG -->|top-k chunks| Part5[Prompt part 5]
  end
```

> RAG subsystem: knowledge documents are uploaded via the CLI, chunked into ~800-token segments, embedded using the company's embedding model, and stored as vectors in PostgreSQL (pgvector). When an agent runs, the initial prompt is embedded and the most similar chunks above the 0.7 cosine threshold are retrieved and injected into the prompt. The embedding model is configured separately from the chat LLM via `company.embeddingConfig`.

---

Key architectural decisions are documented as ADRs in [docs/ADRs/](docs/ADRs/). See [docs/index.md](docs/index.md) for the full list with implementation status.

## Getting started

See **[Setup checklist](docs/setup-checklist.md)** for a step-by-step first-time setup guide.

**Quick start** (prerequisites: Docker, Node.js 24):

```bash
git clone --recurse-submodules https://github.com/instantiator/lcp-server.git && cd lcp-server
cp .env.example .env
npm install
docker compose up -d
```

Follow the steps in **[Your first company](docs/your-first-company.md)** to populate and interact with a simple agent in a company.

## Testing

See **[Testing](docs/testing.md)** for the testing strategy and full tier descriptions.
See **[Scripts](docs/scripts.md)** for all available scripts.

Quick reference:

```bash
./scripts/run-unit-tests.sh         # no services required
./scripts/run-integration-tests.sh  # starts postgres, redis, minio
./scripts/run-smoke-tests.sh        # starts full stack including Keycloak
./scripts/run-e2e-tests.sh          # starts postgres, redis, minio
```

## Technologies

| Concern               | Choice                         |
| --------------------- | ------------------------------ |
| Framework             | NestJS 11                      |
| ORM                   | TypeORM                        |
| Database (production) | PostgreSQL 16 + pgvector       |
| Database (unit tests) | better-sqlite3 (in-memory)     |
| Auth                  | OAuth2/OIDC (Keycloak default) |
| Object storage        | MinIO                          |
| Task queue            | Redis (BullMQ)                 |
| Schema export         | ts-json-schema-generator       |

See [docs/ADRs/](docs/ADRs/) for decisions on upcoming components (agent runner, memory, orchestration).

## Commands reference

| Command                      | Purpose                                                |
| ---------------------------- | ------------------------------------------------------ |
| `npm run build`              | Compile both apps to `dist/`                           |
| `npm run build lcp-server`   | Compile lcp-server only                                |
| `npm run build lcp-agent`    | Compile lcp-agent only                                 |
| `npm run start:dev`          | Start lcp-server with hot reload                       |
| `npm run lint`               | ESLint with auto-fix                                   |
| `npm run format`             | Prettier over `apps/`, `libs/`, and `docs/`            |
| `npm test`                   | Unit tests                                             |
| `npm run test:e2e`           | E2E tests                                              |
| `npm run test:integration`   | Integration tests (needs Docker)                       |
| `npm run test:smoke`         | Smoke tests (needs `docker compose up --profile auth`) |
| `npm run schema:generate`    | Regenerate [schemas/schema.json](schemas/schema.json)  |
| `npm run licenses:generate`  | Regenerate [docs/licenses.md](docs/licenses.md)        |
| `npm run migration:generate` | Generate a new TypeORM migration                       |
| `npm run migration:run`      | Run pending migrations                                 |
| `npm run migration:revert`   | Revert the last migration                              |
