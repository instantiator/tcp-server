# lcp-mcp-memory

**Status:** Implemented
**Port:** 3011
**Transport:** MCP Streamable HTTP — stateless, one session per request

`lcp-mcp-memory` is a NestJS MCP server that gives agents semantic search over episodic memory and the role's knowledge base, and lets them store new episodic memories mid-task. It lives in `apps/lcp-mcp-memory/` and runs as a Docker Compose service with a direct PostgreSQL connection (pgvector).

Each tool call creates a fresh MCP session so no state is shared across requests. The server exposes `GET /health` (checks PostgreSQL connectivity) and `POST /mcp`.

Every tool call writes `tool_call` and `tool_result` audit events to lcp-server via the internal audit endpoint.

See [agent-services.md → MCP Servers](agent-services.md#mcp-servers) for how agents connect, and [ADR-006](ADRs/ADR-006-agent-memory-architecture.md) for the full memory architecture design.

---

## Tools

| Tool                                    | Signature                                      | Description                                          |
| --------------------------------------- | ---------------------------------------------- | ---------------------------------------------------- |
| [`describe_server`](#describe_server)   | `describe_server()`                            | Overview of the memory service and its tools         |
| [`recall`](#recall)                     | `recall(roleId, companyId, query, top_k?)`     | Search episodic memory + knowledge base by similarity |
| [`remember`](#remember)                 | `remember(roleId, companyId, content, agentId?, tags?)` | Store a new episodic memory entry           |
| [`search_knowledge`](#search_knowledge) | `search_knowledge(roleId, companyId, query, top_k?)` | Search the role knowledge base only            |

---

## `describe_server`

Returns a markdown overview of the memory service and its tools.

**Arguments:** none

**Returns:** Markdown text listing all tools and usage guidance.

**Usage pattern:** Agents should call this first when they discover the memory server is available. Prompt part 3 directs agents to do this automatically.

---

## `recall`

Runs a hybrid semantic search across both episodic memory (`episodic_memory` table) and the role's knowledge base (`knowledge_chunk` table), returning the most relevant results for the query.

**Arguments:**

| Parameter   | Type    | Required | Description                                               |
| ----------- | ------- | -------- | --------------------------------------------------------- |
| `roleId`    | UUID    | yes      | The role whose memory and knowledge base to search        |
| `companyId` | UUID    | yes      | The company (used to load the embedding configuration)    |
| `query`     | string  | yes      | Natural-language search query                             |
| `top_k`     | integer | no       | Maximum number of results to return (default: 5)          |

**Returns:** Formatted results listing source, content, and cosine similarity score for each match. Returns a "no results" message if nothing is above the similarity threshold.

**Behaviour when no embedding config exists:** Returns an informative message directing the agent to use the RAG context already injected into its initial prompt instead.

**Similarity threshold:** 0.7 (cosine). Results below this threshold are discarded. The top-k limit is applied after threshold filtering.

**Relationship to RAG injection:** The automatic RAG injection (prompt part 5) runs once before the first LLM call, using the initial task prompt as the query. `recall` is an on-demand search that the agent can call at any point mid-task, with any query.

---

## `remember`

Stores a short piece of information in the role's episodic memory. The content is embedded using the company's embedding model and stored in the `episodic_memory` table for future `recall` searches.

**Arguments:**

| Parameter   | Type     | Required | Description                                                  |
| ----------- | -------- | -------- | ------------------------------------------------------------ |
| `roleId`    | UUID     | yes      | The role to store this memory under                          |
| `companyId` | UUID     | yes      | The company (used to load the embedding configuration)       |
| `content`   | string   | yes      | The content to store                                         |
| `agentId`   | UUID     | no       | The agent instance storing the memory                        |
| `tags`      | string[] | no       | Optional classification tags for future filtering            |

**Returns:** Confirmation message containing the new memory's UUID.

**Behaviour when no embedding config exists:** Returns an informative message; the memory is not stored.

**Storage:** Each `remember` call inserts one row into `episodic_memory` with a computed embedding vector. Tags are stored as a JSONB array.

---

## `search_knowledge`

Searches the role's knowledge base only (RAG source documents in `knowledge_chunk`), excluding episodic memory entries. Useful when the agent needs to retrieve factual reference material mid-conversation.

**Arguments:**

| Parameter   | Type    | Required | Description                                                  |
| ----------- | ------- | -------- | ------------------------------------------------------------ |
| `roleId`    | UUID    | yes      | The role whose knowledge base to search                      |
| `companyId` | UUID    | yes      | The company (used to load the embedding configuration)       |
| `query`     | string  | yes      | Natural-language search query                                |
| `top_k`     | integer | no       | Maximum number of results to return (default: 5)             |

**Returns:** Formatted results (same format as `recall`). Returns a "no results" message if nothing is above the similarity threshold.

**Difference from `recall`:** `search_knowledge` searches `knowledge_chunk` only. `recall` unions both `knowledge_chunk` and `episodic_memory` in a single ranked result set.

---

## Relationship to RAG injection

|                | RAG injection (prompt part 5)     | Memory MCP tools                                    |
| -------------- | --------------------------------- | --------------------------------------------------- |
| When           | Before the first LLM call         | On demand, any time during the loop                 |
| Query          | The agent's initial task prompt   | Any query the agent constructs                      |
| Scope          | `knowledge_chunk` only            | `knowledge_chunk` + `episodic_memory` (for `recall`) |
| Writes         | No                                | `remember` writes to `episodic_memory`               |

---

## Database dependency

lcp-mcp-memory requires a direct PostgreSQL connection (with pgvector) to run similarity queries. The `DATABASE_URL` environment variable must be set. The Docker Compose service has a `depends_on: postgres` constraint and a `/health` endpoint that checks the connection before the service is considered ready.
