# ADR-006: Agent Memory Architecture

Status: Partially Implemented

## Context

Agents need two distinct kinds of stored knowledge:

1. **Episodic memory** — what this _role_ has done before, conclusions reached, lessons learned. Grows over time as agents complete tasks. Role-scoped (not per-agent-instance, since agents are ephemeral roles — see [ADR-001](./ADR-001-service-architecture.md)).
2. **Knowledge base** — specialist domain documents ("how to perform a security audit", "our preferred architecture patterns"). Pre-seeded from OKF-formatted files. Updated by user teaching (see [ADR-012](./ADR-012-human-in-the-loop.md)) and optionally by periodic memory consolidation.

Both systems are accessed by agents through a dedicated **memory MCP server** rather than direct DB calls, keeping the agent loop decoupled from the storage implementation.

## Knowledge base format

All knowledge base documents use **Open Knowledge Format (OKF)**:
https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md

OKF provides a consistent schema for structured knowledge documents. Knowledge base files are stored in the company's shared storage (MinIO — see [ADR-007](./ADR-007-shared-company-storage.md)) and indexed into the vector store on ingest.

## Options for vector storage

| Option                              | Episodic | Knowledge base | Notes                                                                   |
| ----------------------------------- | -------- | -------------- | ----------------------------------------------------------------------- |
| **pgvector** (PostgreSQL extension) | ✓        | ✓              | No extra service; integrates with ADR-004 DB; custom RAG wrapper needed |
| **LanceDB**                         | ✓        | ✓              | Embedded, TypeScript-native; extra dependency; no separate service      |
| **Qdrant**                          | ✓        | ✓              | Dedicated vector DB; excellent performance; adds a Docker service       |

## Decision

**pgvector** (already in the PostgreSQL instance from [ADR-004](./ADR-004-database-strategy.md)).

No extra service or dependency. A thin RAG wrapper (~50 lines) handles embed → store and query → retrieve. Embedding model is configurable per company (Anthropic embeddings API or a local model via LM Studio).

### Role definition schema

Each role carries a `knowledge_base` pointer in its definition (stored in the company's role config):

```typescript
interface RoleDefinition {
  name: string;
  description: string; // human-readable summary of the role
  knowledge_domains: string[]; // used for task assignment heuristics
  knowledge_base: {
    storage_path: string; // path in MinIO to OKF source files
    vector_namespace: string; // pgvector partition for this role's KB
  };
  memory_namespace: string; // pgvector partition for episodic memory
  mcp_server_list: McpServerConfig[]; // role-specific MCP servers (beyond standard)
  llm_config: LlmConfig; // see ADR-003
  system_prompt_template: string; // Handlebars-style template
}
```

### Memory MCP server

The memory MCP server exposes tools to the agent:

| Tool                              | Description                                                  |
| --------------------------------- | ------------------------------------------------------------ |
| `recall(query, top_k?)`           | Semantic search over both episodic memory and knowledge base |
| `remember(content, tags?)`        | Write a new episodic memory entry                            |
| `search_knowledge(query, top_k?)` | Search knowledge base only                                   |

The server is provided as a standard MCP server to all agents (see [ADR-009](./ADR-009-containerization-strategy.md)).

### Memory retention and scrubbing

- **Retention**: indefinite by default; configurable per company
- **Scrubbing API** (interface defined now; implementation deferred):
  - By date range: `DELETE WHERE created_at < threshold`
  - By task ID: remove all memories tagged with a specific task
  - By topic/tag: remove memories with matching tags (requires tagging on write — `remember()` accepts optional `tags`)
- **Memory consolidation** (future): a periodic background job extracts high-value episodic memories and writes them into the role's OKF knowledge base, then prunes the raw episodic entries. Noted here as a planned extension.

### User teaching

When a user teaches a role during a conversation (see [ADR-012](./ADR-012-human-in-the-loop.md)), the orchestrator calls the memory MCP server's `remember()` tool directly with the content, tagged with `source: 'user-teaching'`. If the content is better suited for the knowledge base (a permanent document rather than an episodic note), the user can indicate this and the content is written as an OKF document to company storage and re-indexed.

## Consequences

- Two vector namespaces per role: `{company_id}/{role_name}/memory` and `{company_id}/{role_name}/knowledge`
- Embedding model is configured per company; defaults to a no-cost local model for development
- The memory MCP server is part of the standard LCP MCP suite; it is not optional

## Implementation status

### Implemented

- `EmbeddingService` lives in `libs/lcp-shared/src/rag/` and is shared between lcp-server and lcp-agent
- `KnowledgeChunk` entity and pgvector table (`knowledge_chunk`) with IVFFlat index — used for automatic RAG injection
- `EpisodicMemory` entity and table (`episodic_memory`) with pgvector embedding column
- `RagIndexService` and `RagRetrievalService` in lcp-server — used for knowledge base indexing and retrieval
- lcp-mcp-memory: `recall`, `remember`, and `search_knowledge` tools are fully implemented against pgvector
  - `recall` runs a UNION query over both `episodic_memory` and `knowledge_chunk`, ranked by cosine similarity
  - `remember` embeds content and inserts into `episodic_memory` (with optional tags as JSONB)
  - `search_knowledge` queries `knowledge_chunk` only
- All memory tools write `tool_call` audit events

### Deferred

- Memory consolidation (periodic background job extracting high-value episodic memories into OKF KB docs)
- Memory scrubbing API (delete by date range, task ID, or tag)
- `update_rag_context` / `condense_rag_context` MCP tools (RAG context replacement mid-loop)

## Open Questions / Assumptions

- Embedding dimension must match across memory writes and queries. Changing the embedding model later requires re-embedding all existing memories — plan for a re-index migration script.
- Topic-tagging strategy for scrubbing: tags are free-form strings. A taxonomy may be useful later but is not enforced now.

## Amendments as implemented (010.2.1)

Since `docs/prompts/010.2.1 - task orchestration: knowledge folders and knowledge API.md`:

- **Knowledge is now role-or-shared scoped, not role-only**: a role's knowledge base (`knowledge_base.storage_path` in the schema above) lives at `knowledge/{role_slug}/`; a new company-wide scope lives at `knowledge/shared/` and is queried by all of a company's roles. `KnowledgeChunk.roleId` is nullable — `null` marks a shared-scope chunk — rather than every chunk necessarily belonging to exactly one role.
- **`search_knowledge`/`recall` are not yet shared-aware**: this pass only extended the ingest/remove path (`RagIndexService.ingestDocument`/`removeDocument` now accept `roleId: UUID | null`) to cover the shared scope; retrieval still queries a single `roleId` and does not yet also pull in `knowledge/shared/` chunks. That's deferred to the next piece of work (embedding-sync/scoped-retrieval).

## Amendments as implemented (010.2.2)

Since `docs/prompts/010.2.2 - task orchestration: embedding sync and scoped retrieval.md`:

- **Retrieval now searches role + shared scopes.** All three retrieval paths — `RagRetrievalService.retrieve` (lcp-server), `AgentRagService.retrieve` (lcp-agent), and lcp-mcp-memory's `search_knowledge`/`recall` — changed their chunk predicate from `roleId = $x` to `(("roleId" = $x) OR ("roleId" IS NULL AND "companyId" = $y))`, so a role sees its own chunks plus its company's shared chunks and never another company's. The lcp-server/lcp-agent `retrieve` signatures gained a `companyId` parameter to carry the second scope.
- **Embeddings are kept in sync with storage automatically.** A new `KnowledgeReindexService` (lcp-server) owns a BullMQ `knowledge-reindex` queue + worker fed by two triggers: a `StorageService` write hook (fast path) and a periodic in-process reconciliation poller (`KNOWLEDGE_POLL_INTERVAL_MS`, default 60s) that catches out-of-band edits via a per-scope listing fingerprint. (The poller is a plain `unref`'d interval rather than a BullMQ repeatable job, so a short-lived test app can't leave a scheduled job firing under a later app in a shared-Redis test run.) Restart-on-change is enforced by a per-scope generation counter on the new `KnowledgeIndexState` entity/table (`knowledge_index_state`): the worker skips stale jobs and aborts + re-enqueues if the generation changes mid-rebuild. `KnowledgeService.store`/`delete` no longer index synchronously — the write hook is now the single path by which embeddings are (re)built.
- **Manual reindex trigger.** `POST /api/company/:companyId/knowledge/reindex` (JWT-guarded, 202) and the `reindex-knowledge --company <slug-or-id>` CLI verb bump every scope of a company.
