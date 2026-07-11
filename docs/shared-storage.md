# Shared Storage

Each LCP company has a dedicated folder in MinIO, the S3-compatible object store bundled with the Docker Compose stack. All agents in a company share the same folder: knowledge documents, task working files, context-overflow data, and audit logs are all written here.

See [ADR-007](ADRs/ADR-007-shared-company-storage.md) for the architectural decision and rationale.

## Accessing the web interface

MinIO ships a browser-based console for browsing and managing stored files.

**Open via lcp-cli:**

```bash
./lcp-cli.sh open-document-store
```

This prints the console URL and opens it in your default browser. Pass `--no-open` to print the URL only.

The URL is read from the `MINIO_CONSOLE_URL` environment variable, defaulting to `http://localhost:9001`.

**Open manually:** navigate to [http://localhost:9001](http://localhost:9001) in your browser.

See [`lcp-cli.md` → `open-document-store`](lcp-cli.md#open-document-store) for full flag reference.

## Authentication

### Console login

The MinIO console uses MinIO's own credential system, not OIDC directly.

Log in with the root credentials from your `.env` file:

| Field    | Environment variable  | Default      |
| -------- | --------------------- | ------------ |
| Username | `MINIO_ROOT_USER`     | `minioadmin` |
| Password | `MINIO_ROOT_PASSWORD` | `minioadmin` |

> **OIDC SSO (optional):** MinIO supports federating console login through an OIDC provider. When Keycloak is running under the `auth` profile, it can be configured as the identity provider — users then log in via their Keycloak account instead of the root credentials. This requires additional Keycloak client setup and MinIO OIDC env vars; it is not enabled by default. See [ADR-007](ADRs/ADR-007-shared-company-storage.md) for the planned configuration.

### Programmatic access (lcp-server, MCP storage server)

Application services use static S3 access keys, not OIDC:

| Environment variable | Purpose                  |
| -------------------- | ------------------------ |
| `MINIO_ACCESS_KEY`   | S3 API access key ID     |
| `MINIO_SECRET_KEY`   | S3 API secret access key |

These are set in your `.env` file and injected into Docker Compose services at startup. They are never exposed in API responses or logs.

## Folder structure

Each company's data lives under a top-level prefix derived from the company's `slug`. The structure follows [ADR-007](ADRs/ADR-007-shared-company-storage.md):

```
{company_slug}/
  tasks/
    {task_id}/
      materials/         ← user-submitted inputs; read-only for agents
      output/            ← agent working area during task execution
  knowledge/
    {role_slug}/         ← OKF Markdown documents used for RAG indexing (knowledge for the role)
    shared/              ← OKF Markdown documents used for RAG indexing (company-wide knowledge)
  finished/
    {category}/          ← reports | specifications | designs | code | other
      {task_id}/
        {filename}       ← stable artefacts promoted from tasks/*/output/
  audit/
    {task_id}/
      {step_id}.jsonl    ← append-only audit log per task step
```

### Folder purposes

| Path                        | Written by                     | Read by                   | Notes                                                                                                               |
| --------------------------- | ------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `tasks/{id}/materials/`     | lcp-server (task creation)     | Agents (read-only)        | Task inputs submitted by the user                                                                                   |
| `tasks/{id}/output/`        | Agents                         | Agents, orchestrator      | Working files created during execution                                                                              |
| `knowledge/{role_slug}/`    | lcp-cli `store-knowledge`      | lcp-server (RAG indexing) | Source documents for a role's RAG; see [Agent Services](agent-services.md#rag-retrieval-augmented-generation)       |
| `knowledge/shared/`         | lcp-cli `store-knowledge`      | lcp-server (RAG indexing) | Source documents for company-wide RAG (all roles); `shared` is a reserved role slug and cannot be claimed by a role |
| `finished/{category}/{id}/` | Reviewing agent / orchestrator | All agents                | Stable artefacts promoted on task completion                                                                        |
| `audit/{id}/`               | lcp-agent (planned)            | Operations tooling        | Append-only JSONL audit records per task step                                                                       |

### Context overflow

When incoming data (RAG results, MCP responses) still exceeds the context budget after compaction, the original content is written to a temporary overflow path and a reference summary is injected into the prompt in its place:

```
{company_slug}/tasks/{agent_id}/context-overflow/{timestamp}.txt
```

If the write fails, the compacted (truncated) version is used instead. See [Context Management](context-management.md) for the full compaction strategy.

## Write validation

Documents written through the storage abstraction (`StorageService`, currently backed by `MinioStorageAdapter`) are validated before being accepted — JSON, YAML, OKF Markdown, plain Markdown, XML, and CSV each have a registered validator (`libs/lcp-shared/src/storage/validation/`). OKF documents (under `knowledge/{role_slug}/` or `knowledge/shared/`) require YAML front-matter with a non-empty `title` field; other formats get structural well-formedness checks, plus JSON-Schema validation when the document names a local `$schema` reference (remote schema URLs are never fetched — see `docs/prompts/009.4 - doc type validations.md` §Risks for why).

A failed validation returns `422 Unprocessable Entity` with a body of `{ statusCode, message, errors: [{ message, path?, llmHint }] }`. `errors[].llmHint` is written to be directly actionable by the calling agent — relay it back into the agent's context rather than the raw parser error.

Every write also records an audit event carrying `originators: { user, agent, task }` — `user` is populated for direct JWT-authenticated writes (`POST /api/storage`, `POST /api/role/:roleId/knowledge`, `POST /api/company/:companyId/knowledge`); `agent`/`task` are populated for MCP-tool-initiated writes once wired (see the shared-lib `AuditEvent.payload` shape in `docs/database.md`).

## Managing knowledge documents

Knowledge documents are uploaded via lcp-cli, scoped to either a role (`knowledge/{role_slug}/`) or a company's shared knowledge (`knowledge/shared/`). The server chunks, embeds, and indexes them for RAG retrieval automatically.

> **Migration note (010.2.1):** the knowledge folder layout moved from name-based (`knowledge/{role_name}/`) to slug-based (`knowledge/{role_slug}/`), and the `AllowSharedKnowledgeChunks` migration truncates the `knowledge_chunk` table (existing chunks referenced the old paths and can no longer be resolved). Any knowledge documents previously uploaded must be re-uploaded via `store-knowledge` after this migration runs — the underlying MinIO objects are untouched, only their RAG index is cleared.

### Automatic RAG sync (010.2.2)

Embeddings are kept in sync with the folder contents automatically, whoever changes them — you via the API/CLI, an agent via the storage tools, or a person editing directly in the MinIO console. The unit of reindexing is a whole _scope_ (`knowledge/{role_slug}/` or `knowledge/shared/`): a rebuild re-lists, re-chunks, and re-embeds every file in the scope and replaces that scope's rows in `knowledge_chunk`. Two triggers feed one BullMQ queue (`knowledge-reindex`), and both run inside lcp-server:

1. **Write hook (fast path).** `StorageService` is the single chokepoint for all lcp-server-mediated writes; after any successful write/delete/restore/move/copy under a `knowledge/` prefix it enqueues a rebuild for the affected scope.
2. **Reconciliation poller (safety net).** A periodic in-process loop (interval `KNOWLEDGE_POLL_INTERVAL_MS`, default `60000`) fingerprints each scope's storage listing and enqueues a rebuild for any scope that has drifted from the fingerprint recorded at its last successful rebuild. This is what catches direct MinIO-console edits that never went through the write hook. Each running lcp-server instance polls independently; bumps are generation-guarded, so overlapping polls are harmless.

Restart-on-change is handled by a per-scope generation counter (`knowledge_index_state`): every trigger atomically bumps the counter and enqueues a job carrying the new value. The worker skips any job older than the current generation and aborts + re-enqueues if the generation changes mid-rebuild, so a burst of writes collapses into a single up-to-date rebuild with no half-indexed state. Because indexing is asynchronous, chunks may appear a moment after an upload rather than synchronously.

To force a rebuild of every scope of a company immediately (rather than waiting for the poller), use the manual trigger:

```bash
./lcp-cli.sh reindex-knowledge -c <company-slug-or-id>
# → POST /api/company/:companyId/knowledge/reindex (202 Accepted)
```

```bash
# Upload a document to a role's knowledge base
./lcp-cli.sh store-knowledge -r <roleId> -s policy.md

# Upload a document to the company's shared knowledge
./lcp-cli.sh store-knowledge -c <companyId> -s handbook.md

# List stored documents
./lcp-cli.sh list-knowledge -r <roleId>
./lcp-cli.sh list-knowledge -c <companyId>

# Retrieve a document's content
./lcp-cli.sh get-knowledge -r <roleId> -f policy.md

# Remove a document by filename
./lcp-cli.sh delete-knowledge -r <roleId> -f policy.md

# Force a full RAG rebuild of every scope of a company
./lcp-cli.sh reindex-knowledge -c <companyId>
```

See [`lcp-cli.md` → knowledge management verbs](lcp-cli.md#list-knowledge) and [Agent Services → RAG](agent-services.md#rag-retrieval-augmented-generation) for full details.

---

## Downloading and uploading documents from the CLI

```bash
# Download a file from storage to the local filesystem
./lcp-cli.sh download-shared-document \
  --source acme/tasks/xyz/output/report.md \
  --target ~/Desktop/report.md        # optional; defaults to ./<filename>

# Upload a local file to storage
./lcp-cli.sh upload-shared-document \
  --source ./architecture.md \
  --target acme/knowledge/architect/architecture.md
```

Both commands write a JSON result to stdout and progress messages to stderr. See [lcp-cli.md](lcp-cli.md#download-shared-document) for full option details.

---

## Agent access via MCP

Agents read and write files through the [lcp-mcp-storage](lcp-mcp-storage.md) MCP server rather than directly via the S3 API. The server exposes 12 tools including soft delete (files moved to `_deleted/` rather than permanently removed), overwrite safety, file search with glob patterns, metadata inspection, copy, move, and structural file summary. See [lcp-mcp-storage.md](lcp-mcp-storage.md) for the full tool reference.

## Internal storage-action endpoints

Since `docs/prompts/009.4 - doc type validations.md`, the full file-action surface (list, read, write, delete, restore, search, properties, copy, move, summary, exists) lives on `lcp-server` under `POST /internal/storage/*` (plus `GET /internal/storage/exists`), guarded by `X-Internal-Api-Key` rather than JWT — these are service-to-service endpoints backing `lcp-mcp-storage`'s MCP tools, not for direct CLI/human use. `StorageProxyController`'s JWT-guarded `GET/POST /api/storage` remains the human-facing generic get/put-by-key surface. `delete`/`restore` are soft-delete (files move to `_deleted/`), matching the MCP tool semantics described above — `deleteKnowledgeFile` now delegates to the same soft-delete primitive rather than hard-deleting.
