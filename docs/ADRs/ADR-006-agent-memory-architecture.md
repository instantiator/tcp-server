# ADR-006: Agent Memory Architecture

Status: Partially Implemented

## Context

Agents need two distinct kinds of stored knowledge:

1. **Episodic memory** — what this _role_ has done before, conclusions reached, lessons learned. Grows over time as agents complete tasks. Role-scoped (not per-agent-instance, since agents are ephemeral roles — see [ADR-001](./ADR-001-service-architecture.md)).
2. **Knowledge base** — specialist domain documents ("how to perform a security audit", "our preferred architecture patterns"). Pre-seeded from OKF-formatted files. Updated by user teaching (see [ADR-012](./ADR-012-human-in-the-loop.md)) and optionally by periodic memory consolidation.

Both systems are accessed by agents through a dedicated **memory MCP server** rather than direct DB calls, keeping the agent loop decoupled from the storage implementation.

## Knowledge base format

All knowledge base documents use **Open Knowledge Format (OKF)**:
<https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md>

OKF provides a consistent schema for structured knowledge documents. Knowledge base files are stored in the company's shared storage (MinIO — see [ADR-007](./ADR-007-shared-company-storage.md)) and indexed into the vector store on ingest.

## Options for vector storage

| Option                              | Episodic | Knowledge base | Notes                                                                   |
| ----------------------------------- | -------- | -------------- | ----------------------------------------------------------------------- |
| **pgvector** (PostgreSQL extension) | ✓        | ✓              | No extra service; integrates with ADR-004 DB; custom RAG wrapper needed |
| **LanceDB**                         | ✓        | ✓              | Embedded, TypeScript-native; extra dependency; no separate service      |
| **Qdrant**                          | ✓        | ✓              | Dedicated vector DB; excellent performance; adds a Docker service       |

## Decision

**pgvector** (already in the PostgreSQL instance from [ADR-004](./ADR-004-database-strategy.md)).

No extra service or dependency. A thin RAG wrapper (~50 lines) handles embed → store and query → retrieve. Embedding model is configurable per company (`LlmConfig.provider`: `'openai'` or a local model via `'lm-studio'`).

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
- The memory MCP server is part of the standard TCP MCP suite; it is not optional

## Implementation status

### Implemented

- `EmbeddingService` lives in `libs/tcp-shared/src/rag/` and is shared between tcp-server and tcp-agent
- `KnowledgeChunk` entity and pgvector table (`knowledge_chunk`) with IVFFlat index — used for automatic RAG injection
- `EpisodicMemory` entity and table (`episodic_memory`) with pgvector embedding column
- `RagIndexService` and `RagRetrievalService` in tcp-server — used for knowledge base indexing and retrieval
- tcp-mcp-memory: `recall`, `remember`, and `search_knowledge` tools are fully implemented against pgvector
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

<a id="amendments-as-implemented-01021"></a>

## Amendments as implemented (010.2.1) — knowledge folders and knowledge API

- **Knowledge is now role-or-shared scoped, not role-only**: a role's knowledge base (`knowledge_base.storage_path` in the schema above) lives at `knowledge/{role_slug}/`; a new company-wide scope lives at `knowledge/shared/` and is queried by all of a company's roles. `KnowledgeChunk.roleId` is nullable — `null` marks a shared-scope chunk — rather than every chunk necessarily belonging to exactly one role.
- **`search_knowledge`/`recall` are not yet shared-aware**: this pass only extended the ingest/remove path (`RagIndexService.ingestDocument`/`removeDocument` now accept `roleId: UUID | null`) to cover the shared scope; retrieval still queries a single `roleId` and does not yet also pull in `knowledge/shared/` chunks. That's deferred to the next piece of work (embedding-sync/scoped-retrieval).

<a id="amendments-as-implemented-01022"></a>

## Amendments as implemented (010.2.2) — embedding sync and scoped retrieval

- **Retrieval now searches role + shared scopes.** All three retrieval paths — `RagRetrievalService.retrieve` (tcp-server), `AgentRagService.retrieve` (tcp-agent), and tcp-mcp-memory's `search_knowledge`/`recall` — changed their chunk predicate from `roleId = $x` to `(("roleId" = $x) OR ("roleId" IS NULL AND "companyId" = $y))`, so a role sees its own chunks plus its company's shared chunks and never another company's. The tcp-server/tcp-agent `retrieve` signatures gained a `companyId` parameter to carry the second scope.
- **Embeddings are kept in sync with storage automatically.** A new `KnowledgeReindexService` (tcp-server) owns a BullMQ `knowledge-reindex` queue + worker fed by two triggers: a `StorageService` write hook (fast path) and a periodic in-process reconciliation poller (`KNOWLEDGE_POLL_INTERVAL_MS`, default 60s) that catches out-of-band edits via a per-scope listing fingerprint. (The poller is a plain `unref`'d interval rather than a BullMQ repeatable job, so a short-lived test app can't leave a scheduled job firing under a later app in a shared-Redis test run.) Restart-on-change is enforced by a per-scope generation counter on the new `KnowledgeIndexState` entity/table (`knowledge_index_state`): the worker skips stale jobs and aborts + re-enqueues if the generation changes mid-rebuild. `KnowledgeService.store`/`delete` no longer index synchronously — the write hook is now the single path by which embeddings are (re)built.
- **Manual reindex trigger.** `POST /api/company/:companyId/knowledge/reindex` (JWT-guarded, 202) and the `reindex-knowledge --company <slug-or-id>` CLI verb bump every scope of a company.

<a id="amendments-as-implemented-01071"></a>

## Amendments as implemented (010.7.1) — wider knowledge ingestion and OKF generation

- **`store-knowledge` accepts a wider set of source formats**, converted to OKF Markdown server-side (`apps/tcp-server/src/api/knowledge-conversion.ts`): `.md` (passed through unchanged), `.txt`, `.html` (via `turndown` + `turndown-plugin-gfm`, title from `<title>`), `.pdf` (via `pdf-parse`, plain text), `.docx` (via `mammoth`'s `convertToHtml` + the same turndown pipeline as `.html` — its shipped types omit `convertToMarkdown`), and `.csv`/`.json`/`.yaml` (wrapped in a fenced code block after a well-formedness check). `tcp-cli`'s client-side pre-check now only verifies the extension is supported; the server performs the real conversion and OKF validation.
- **Heuristic title generation, not an LLM.** For genuinely converted (non-`.md`) formats, `ensureOkfFrontMatter` picks a title in order: a title discovered during conversion (HTML `<title>`, DOCX's first heading) → the first `#`/`##` heading in the converted body → the filename stem. `.md` sources are deliberately excluded from this — they keep today's strict `validateOkf` gate (missing/invalid front-matter is rejected with 422, not papered over with a guessed title), since `.md` is already OKF's native format and a user uploading one is expected to supply real front-matter.
- **Non-`.md` uploads are stored under a derived `.md` filename** (source basename + `.md`), unless the caller passes an explicit `filename` override. A derived name colliding with an existing document is rejected with 409 (not silently overwritten) unless an explicit `filename` is given — re-uploading the same source again still overwrites, since re-deriving the same name is intentional.
- **`pdf-parse`'s worker setup cannot run inside Jest's default (non-ESM) test environment.** `pdfjs-dist` (which `pdf-parse` v2 wraps) sets up its text-extraction "fake worker" via a dynamic `import()`, which Jest rejects without `--experimental-vm-modules` — a Jest sandboxing limitation, not a real runtime issue (confirmed working under plain Node, and under the real server process exercised by `test/api/api.spec.ts`). `apps/tcp-server/src/api/knowledge-conversion.spec.ts` mocks `pdf-parse` accordingly; real end-to-end `.pdf` extraction is only covered by `test/api/api.spec.ts` (a separate server process), not by any `*.e2e-spec.ts` (which run the app in-process via Jest's `TestingModule` and would hit the same limitation).

<a id="amendments-as-implemented-01072"></a>

## Amendments as implemented (010.7.2) — knowledge-index status verb

- **Knowledge-index status is queryable.** `GET /api/role/:roleId/knowledge/status` and `GET /api/company/:companyId/knowledge/status` (both JWT-guarded), plus the `get-knowledge-index-status (--role <slug-or-id>|--company <slug-or-id>)` CLI verb, report `{ documentCount, totalBytes, chunkCount, generation, lastIndexedAt, indexing }` for a scope — the company route returns the shared scope's status plus one entry per role (`{ shared, roles: [{ roleId, roleSlug, status }] }`). No new columns were added: document count/size come from `StorageService.listKnowledgeFiles`, chunk count from a `knowledge_chunk` count query, generation/`lastIndexedAt` from `KnowledgeIndexState` (`lastIndexedAt` is `null` until a fingerprint — written only on a completed rebuild — exists), and `indexing` from a new `KnowledgeReindexService.isRebuilding` check against the BullMQ queue's active/waiting/delayed jobs.
