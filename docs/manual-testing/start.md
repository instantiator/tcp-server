# Manual Testing — Start Here

This guide walks you through manually testing the LCP system end to end. Work through each section in order: later sections depend on data created earlier (companies, roles, documents).

Each section is self-contained: it tells you what you are testing, what commands to run, and what to expect. Where a section builds on a previous one, there is a note at the top.

```mermaid
flowchart TD
    A[Infrastructure] --> B[Companies & Roles]
    B --> C[Chat Agents]
    B --> D[Autonomous Agents]
    B --> E[RAG & Documents]
    E --> F[MCP Servers]
    A --> F
```

---

## Prerequisites

Before starting, ensure the following are in place.

| Requirement            | How to verify                                                        |
| ---------------------- | -------------------------------------------------------------------- |
| Docker running         | `docker info` returns engine details                                 |
| `.env` file present    | `ls .env` — copy from `.env.example` if missing                      |
| LLM provider reachable | LM Studio (or similar) running and accessible from the URL in `.env` |
| Node.js ≥ 22           | `node --version`                                                     |

If you do not have a `.env` file, copy the example and fill in the LLM provider details:

```bash
cp .env.example .env
```

---

## Sections

Work through these in order.

| #   | Section                                          | What you are testing                                                      | Estimated time |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------- | -------------- |
| 1   | [Infrastructure](./01-infrastructure.md)         | Docker Compose startup, health checks, MinIO console                      | ~5 min         |
| 2   | [Companies & Roles](./02-companies-and-roles.md) | Creating and inspecting companies and roles via the CLI                   | ~10 min        |
| 3   | [Chat Agents](./03-chat-agents.md)               | Starting a chat agent, sending a message, reading the response            | ~10 min        |
| 4   | [Autonomous Agents](./04-autonomous-agents.md)   | Dispatching an autonomous agent job and verifying completion              | ~10 min        |
| 5   | [RAG & Documents](./05-rag-documents.md)         | Uploading knowledge documents, verifying RAG retrieval in agent responses | ~15 min        |
| 6   | [MCP Servers](./06-mcp-servers.md)               | Health checks, tool listing, and storage operations via MCP               | ~10 min        |

---

## Quick reference — service ports

| Service              | Port | Purpose                           |
| -------------------- | ---- | --------------------------------- |
| lcp-server           | 3000 | REST API                          |
| lcp-agent            | 3001 | Agent loop health                 |
| lcp-mcp-storage      | 3010 | Storage MCP server                |
| lcp-mcp-memory       | 3011 | Memory MCP server (stub)          |
| lcp-mcp-interactions | 3012 | Interactions MCP server (stub)    |
| MinIO API            | 9000 | S3-compatible object storage      |
| MinIO console        | 9001 | Web UI for browsing stored files  |
| Keycloak             | 8080 | OIDC provider (auth profile only) |

---

## Useful aliases

You will use the CLI frequently. These aliases make the commands shorter:

```bash
alias lcp="./lcp-cli.sh"
export TOKEN=$(lcp --username test --password test get-token)
```

---

## If something goes wrong

- **Service not starting**: check `docker compose logs <service-name>` for error detail.
- **401 from lcp-server**: your token has expired — re-run `get-token` and update `$TOKEN`.
- **LLM errors**: confirm your LLM provider is running and the `baseUrl` in your company/role config is reachable.
- **MinIO errors**: the lcp-mcp-storage server logs to `docker compose logs lcp-mcp-storage`.
