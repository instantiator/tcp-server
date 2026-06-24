# lcp-mcp-memory

**Status:** Stub — all tools return "not yet implemented" responses
**Port:** 3011
**Transport:** MCP Streamable HTTP — stateless, one session per request

`lcp-mcp-memory` is a NestJS MCP server intended to give agents semantic search over episodic memory and the role's knowledge base. It lives in `apps/lcp-mcp-memory/` and runs as a Docker Compose service.

All tools are currently stubs. Agents can call them without errors, but they receive an informative "not yet implemented" message in return. The `recall` and `search_knowledge` stubs additionally direct the agent to use the RAG context already injected into prompt part 5 instead.

The infrastructure needed for a real implementation already exists: `RagRetrievalService`, `EmbeddingService`, and the `knowledge_chunk` pgvector table are all live in lcp-server. What remains is wiring them into this service (which would need its own DB connection and access to those services), and adding an episodic memory table for `remember`/`recall`.

See [agent-services.md → MCP Servers](agent-services.md#mcp-servers) for how agents connect, and [ADR-006](ADRs/ADR-006-agent-memory-architecture.md) for the full memory architecture design.

---

## Tools

| Tool                                    | Signature                         | Status | Description                                  |
| --------------------------------------- | --------------------------------- | ------ | -------------------------------------------- |
| [`describe_server`](#describe_server)   | `describe_server()`               | Stub   | Overview of the memory service and its tools |
| [`recall`](#recall)                     | `recall(query, top_k?)`           | Stub   | Search episodic and knowledge memory         |
| [`remember`](#remember)                 | `remember(content, tags?)`        | Stub   | Store an episodic memory entry               |
| [`search_knowledge`](#search_knowledge) | `search_knowledge(query, top_k?)` | Stub   | Search the role knowledge base only          |

---

## `describe_server`

Returns a markdown overview of the memory service and its tools.

**Arguments:** none

**Returns:** Markdown text listing all tools. The description notes that tools are stubs.

**Usage pattern:** Agents should call this first when they discover the memory server is available. Prompt part 3 directs agents to do this automatically.

---

## `recall`

Intended to run a semantic search across both the episodic memory store and the role's knowledge base, returning the most relevant entries for the given query.

**Arguments:**

| Parameter | Type    | Required | Description                         |
| --------- | ------- | -------- | ----------------------------------- |
| `query`   | string  | yes      | The search query                    |
| `top_k`   | integer | no       | Maximum number of results to return |

**Current behaviour (stub):** Returns `"Memory recall is not yet implemented. Use the RAG context already injected into your initial prompt for knowledge retrieval."`

**Planned behaviour:** Embed the query, run a pgvector cosine similarity search over both `episodic_memory` (agent-written entries) and `knowledge_chunk` (RAG source docs) tables, and return the top-k results above a similarity threshold.

---

## `remember`

Intended to store a short piece of information in the agent's episodic memory, optionally tagged for later retrieval.

**Arguments:**

| Parameter | Type     | Required | Description                               |
| --------- | -------- | -------- | ----------------------------------------- |
| `content` | string   | yes      | The content to store                      |
| `tags`    | string[] | no       | Optional tags to associate with the entry |

**Current behaviour (stub):** Returns `"Episodic memory storage is not yet implemented."`

**Planned behaviour:** Insert a row into an `episodic_memory` table (agentId, roleId, content, embedding, tags, createdAt). Embedding is computed via the company's `embeddingConfig` model.

---

## `search_knowledge`

Intended to search only the role's knowledge base (RAG source documents), excluding episodic memory entries. Useful when the agent needs to retrieve factual reference material mid-conversation rather than relying solely on what was injected at prompt assembly time.

**Arguments:**

| Parameter | Type    | Required | Description                         |
| --------- | ------- | -------- | ----------------------------------- |
| `query`   | string  | yes      | The search query                    |
| `top_k`   | integer | no       | Maximum number of results to return |

**Current behaviour (stub):** Returns `"Knowledge search is not yet implemented. Use the RAG context already injected into your initial prompt."`

**Planned behaviour:** Embed the query, run a pgvector cosine similarity search over `knowledge_chunk` rows scoped to the current role, and return the top-k results. This is the same retrieval that happens automatically at prompt part 5, but exposed as an on-demand tool for mid-conversation use.

---

## Relationship to RAG

The automatic RAG injection (prompt part 5) and this server's `recall` / `search_knowledge` tools address the same underlying data but at different points in the agent lifecycle:

|        | RAG injection (prompt part 5) | Memory MCP tools                           |
| ------ | ----------------------------- | ------------------------------------------ |
| When   | Before the first LLM call     | On demand, any time during the loop        |
| Query  | The agent's initial prompt    | Any query the agent chooses                |
| Scope  | Role knowledge base only      | Knowledge base + episodic memory (planned) |
| Status | Implemented                   | Stub                                       |
