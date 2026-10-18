# Shared Storage

Each TCP company has a dedicated folder in MinIO, the S3-compatible object store bundled with the Docker Compose stack. All agents in a company share the same folder: knowledge documents, task working files, context-overflow data, and audit logs are all written here.

See [ADR-007](ADRs/ADR-007-shared-company-storage.md) for the architectural decision and rationale.

## Accessing the web interface

MinIO ships a browser-based console for browsing and managing stored files.

**Open via tcp-cli:**

```bash
./tcp-cli.sh open-document-store
```

This prints the console URL and opens it in your default browser. Pass `--no-open` to print the URL only.

The URL is read from the `MINIO_CONSOLE_URL` environment variable, defaulting to `http://localhost:9001`.

**Open manually:** navigate to [http://localhost:9001](http://localhost:9001) in your browser.

See [`tcp-cli.md` → `open-document-store`](tcp-cli.md#open-document-store) for full flag reference.

### Links from the web client's archive tray

The office view's archive room links each succeeded task straight to its
outputs folder in the console (`ArchiveDetails.tsx`, 002.02). Two of the same
environment variables reach `tcp-web` too, through `docker-compose.yml` and
`docker/nginx/10-tcp-init.sh`:

| Environment variable  | Runtime config field | Used for                            |
| --------------------- | -------------------- | ----------------------------------- |
| `MINIO_CONSOLE_URL`   | `storageConsoleUrl`  | The console's origin                |
| `MINIO_BUCKET_PREFIX` | `storageBucket`      | The bucket the company data sits in |

Both are optional. With either unset, the archive tray still lists completed
tasks — just as plain text, with no link.

**Confirmed link format** (002.02 stage 9, against a running `pgsty/silo`
container — the MinIO fork this stack bundles):

```text
{storageConsoleUrl}/browser/{storageBucket}/{encodeURIComponent(prefix)}
```

`prefix` is the task's `completed/` folder (`{company_slug}/tasks/{task_id}/completed/`),
kept as a single percent-encoded path segment — its slashes become `%2F`. This
is **not** MinIO's classic console format, which base64-encodes the prefix
instead. A base64 prefix was tried against the same container and left the
browser on the bucket root, reading the encoded string as a literal
(non-existent) folder name; the percent-encoded form round-trips correctly.
See the [Silo link format drift](prompts/unresolved-notes.md#silos-console-link-format-was-confirmed-against-one-image-tag)
unresolved note — this is confirmed against one image tag, not guaranteed
across every future Silo release.

## Authentication

### Console login

The MinIO console uses MinIO's own credential system, not OIDC directly.

Log in with the root credentials from your `.env` file:

| Field    | Environment variable  | Default      |
| -------- | --------------------- | ------------ |
| Username | `MINIO_ROOT_USER`     | `minioadmin` |
| Password | `MINIO_ROOT_PASSWORD` | `minioadmin` |

> **OIDC SSO (optional):** MinIO supports federating console login through an OIDC provider. When Zitadel is running under the `auth` profile, it can be configured as the identity provider — users then log in via their Zitadel account instead of the root credentials. This requires additional Zitadel application setup and MinIO OIDC env vars; it is not enabled by default. See [ADR-007](ADRs/ADR-007-shared-company-storage.md) for the planned configuration.

### Programmatic access (tcp-server, MCP storage server)

Application services use static S3 access keys, not OIDC:

| Environment variable | Purpose                  |
| -------------------- | ------------------------ |
| `MINIO_ACCESS_KEY`   | S3 API access key ID     |
| `MINIO_SECRET_KEY`   | S3 API secret access key |

These are set in your `.env` file and injected into Docker Compose services at startup. They are never exposed in API responses or logs.

## Folder structure

Each company's data lives under a top-level prefix derived from the company's `slug`. The structure follows [ADR-007](ADRs/ADR-007-shared-company-storage.md):

```text
{company_slug}/
  tasks/
    {task_id}/
      materials/               ← user-submitted inputs; read-only for agents
      completed/                ← final outputs of the task
        resources/               ← the task's resource changes, applied when it succeeds
      assignments/
        {orderIndex}/
          working/               ← private working area for the assignment's agent
            resources/           ← drafts of company resource changes
          completed/             ← files promoted from working/ when QA accepts
            resources/           ← approved resource drafts
  assignments/
    {assignment_id}/
      working/                 ← working area for ORPHAN assignments (agents outside any task)
  resources/                   ← company resources: long-lived company documents
  knowledge/
    {role_slug}/               ← OKF Markdown documents used for RAG indexing (knowledge for the role)
    shared/                    ← OKF Markdown documents used for RAG indexing (company-wide knowledge)
  audit/
    {task_id}/
      {step_id}.jsonl          ← append-only audit log per task step
```

> **Migration note (010.2.3):** the `tasks/{id}/output/` and `finished/{category}/{id}/` layout drafted in ADR-007 was never implemented and is superseded by the tree above — see [tasks.md](tasks.md) for the full `TcpTask`/`TcpAssignment` data model.

### Folder purposes

| Path                                             | Written by                                 | Read by                   | Notes                                                                                                                                  |
| ------------------------------------------------ | ------------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `tasks/{id}/materials/`                          | tcp-server (`POST .../materials`)          | Agents (read-only)        | Task inputs submitted by the user                                                                                                      |
| `tasks/{id}/completed/`                          | Orchestrator (finalisation)                | All agents                | Final outputs of the task, copied from its assignments' `completed/` directories                                                       |
| `tasks/{id}/assignments/{orderIndex}/working/`   | The assignment's agent                     | The assignment's agent    | Private scratch area for one plan step (a task's implement-mode assignment)                                                            |
| `tasks/{id}/assignments/{orderIndex}/completed/` | Orchestrator (on QA accept)                | Later assignments, task   | Files promoted from `working/` when QA accepts; `resolveArtifactKey` finds the most recent prior assignment approving a given filename |
| `assignments/{assignment_id}/working/`           | The (orphan) assignment's agent            | The assignment's agent    | Working area for assignments outside any task — plain conversations/consultations                                                      |
| `resources/`                                     | Chat agents (directly); tasks (on success) | All agents                | Company resources: invoices, price lists, policies. See [Company resources](#company-resources)                                        |
| `knowledge/{role_slug}/`                         | tcp-cli `store-knowledge`                  | tcp-server (RAG indexing) | Source documents for a role's RAG; see [Agent Services](agent-services.md#rag-retrieval-augmented-generation)                          |
| `knowledge/shared/`                              | tcp-cli `store-knowledge`                  | tcp-server (RAG indexing) | Source documents for company-wide RAG (all roles); `shared` is a reserved role slug and cannot be claimed by a role                    |
| `audit/{id}/`                                    | tcp-agent (planned)                        | Operations tooling        | Append-only JSONL audit records per task step                                                                                          |

### Context overflow

When incoming data (RAG results, MCP responses) still exceeds the context budget after compaction, the original content is written to a temporary overflow path and a reference summary is injected into the prompt in its place:

```text
{company_slug}/tasks/{agent_id}/context-overflow/{timestamp}.txt
```

If the write fails, the compacted (truncated) version is used instead. See [Context Management](context-management.md) for the full compaction strategy.

## Company resources

`{company_slug}/resources/` holds long-lived company documents: invoices, price lists, policies, listing copy. A task's working files belong to that task. A resource belongs to the company and is meant to be found and used again.

A folder's purpose is its `README.md`, which is an ordinary resource. Agents and users can both edit it. Resources are text only, so a PDF or an image can't be read or written by an agent.

Agents use five tools in the storage server: `list_resources`, `read_resource`, `write_resource`, `append_resource` and `replace_in_resource`. See [tcp-mcp-storage.md](tcp-mcp-storage.md#company-resources).

Where a change goes depends on the agent's mode:

| Mode                | Reads from                                                            | Writes to                                                         |
| ------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `chat`              | `resources/`                                                          | `resources/` directly. The user in the conversation is the review |
| `implement`         | Its own draft, then earlier approved steps' drafts, then `resources/` | Its own draft: `.../working/resources/`                           |
| `qa`                | The same layers as the step it reviews                                | Nothing (read-only)                                               |
| `finalise`          | The task's pending changes, then `resources/`                         | The task's pending changes: `tasks/{id}/completed/resources/`     |
| `plan`, `consultee` | `resources/`                                                          | Nothing (read-only)                                               |

### Drafts, then apply

Inside a task a resource change is a **draft**. It moves through the same steps as any other output:

1. The implementing agent writes the draft into its `working/resources/` folder.
2. When QA accepts the step, **every** file under `working/resources/` is promoted to the step's `completed/resources/`, whether or not it was listed in `prepared`.
3. When the task finalises, the steps' `completed/resources/` files are gathered into the task's `completed/resources/` folder. Unlike other files, they keep their folders.
4. **Apply:** just before the task is marked `succeeded`, each file in the task's `completed/resources/` is copied over the live file in `resources/`. This happens on both finalise paths: the mechanical one, and after a finalise agent has run.

The task's copy stays where it is, as the record of what the task changed. Its `completed` list names each change as a `resource` entry. If a task fails, nothing is applied. If applying stops part-way, the task fails and its failure reason names what was already applied. Running apply twice is harmless: it writes the same content again as a new version.

See [tasks.md → Company resources](tasks.md#company-resources).

## Versioning and retention

tcp-server turns on MinIO bucket versioning when it starts. After that, overwriting or deleting a file keeps the old version. Old versions are not kept forever. Lifecycle rules remove a version once it has been replaced for longer than the retention period.

| Setting                               | Where                                                       | Default |
| ------------------------------------- | ----------------------------------------------------------- | ------- |
| `STORAGE_VERSION_RETENTION_DAYS`      | Environment variable on tcp-server (and `.env`)             | 90 days |
| `versionRetentionDays` on the company | Company field, set through the API or `tcp-cli set-company` | unset   |

A company's `versionRetentionDays` wins over the environment variable. Set it to `null` to go back to the default. For example:

```bash
./tcp-cli.sh -t $TOKEN set-company --company-slug acme -i '{"versionRetentionDays": 365}'
```

tcp-server writes one lifecycle rule for each company folder (`{slug}/`), plus one for `_deleted/` at the default. It rewrites the rules at start-up, and shortly after a company is created or its `versionRetentionDays` changes. A deleted company's rule stays until the next start. Failures are logged and do not stop storage working.

Versioning covers the whole bucket, so working-file edits keep old versions too. S3 allows about 1,000 lifecycle rules per bucket, which limits how many companies one deployment can hold. See [outstanding-issues.md](outstanding-issues.md).

### Restoring an old version

Restoring is done in the MinIO console for now. The wording of the console changes between releases, so look for the equivalent of each step.

1. Open the console. Run `./tcp-cli.sh open-document-store`, or go to `MINIO_CONSOLE_URL` (default [http://localhost:9001](http://localhost:9001)), and log in as described under [Authentication](#console-login).
2. Browse the bucket to the file, for example `{company_slug}/resources/price-list.md`.
3. Select the file and open its version history. The console calls this "Versions" or "Display Object Versions". It lists each version with its date and size.
4. Pick the version you want. Restore it, or download it and upload it again.

Restoring does not remove the newer versions. It makes a **new current version** with the old content, so you can undo the restore the same way.

A version is only there until its retention period ends. Restore soon after the bad change.

## Write validation

Documents written through the storage abstraction (`StorageService`, currently backed by `MinioStorageAdapter`) are validated before being accepted — JSON, YAML, OKF Markdown, plain Markdown, XML, and CSV each have a registered validator (`libs/tcp-shared/src/storage/validation/`). OKF documents (under `knowledge/{role_slug}/` or `knowledge/shared/`) require YAML front-matter with a non-empty `title` field (and may carry `source`, `license` and `attribution`, which knowledge listings return — see [company-templates.md](company-templates.md#knowledge-licences)); other formats get structural well-formedness checks, plus JSON-Schema validation when the document names a local `$schema` reference (remote schema URLs are never fetched, to avoid the server making outbound requests driven by untrusted document content).

A failed validation returns `422 Unprocessable Entity` with a body of `{ statusCode, message, errors: [{ message, path?, llmHint }] }`. `errors[].llmHint` is written to be directly actionable by the calling agent — relay it back into the agent's context rather than the raw parser error.

Every write also records an audit event carrying `originators: { user, agent, task }` — `user` is populated for direct JWT-authenticated writes (`POST /api/storage`, `POST /api/role/:roleId/knowledge`, `POST /api/company/:companyId/knowledge`); `agent` is populated for MCP-tool-initiated writes, and `task` for the copies that apply a task's company resource changes (see the shared-lib `AuditEvent.payload` shape in `docs/database.md`).

## Managing knowledge documents

Knowledge documents are uploaded via tcp-cli or the web client (company page, **Admin** tab: a role's dialog has a Knowledge tab, and **Admin → Knowledge** holds the company's shared documents). Uploads are limited to 50 MB; a larger file gets `413`. A document belongs to either a role (`knowledge/{role_slug}/`) or a company's shared knowledge (`knowledge/shared/`). The server chunks, embeds, and indexes them for RAG retrieval automatically.

> **Migration note (010.2.1):** the knowledge folder layout moved from name-based (`knowledge/{role_name}/`) to slug-based (`knowledge/{role_slug}/`), and the `AllowSharedKnowledgeChunks` migration truncates the `knowledge_chunk` table (existing chunks referenced the old paths and can no longer be resolved). Any knowledge documents previously uploaded must be re-uploaded via `store-knowledge` after this migration runs — the underlying MinIO objects are untouched, only their RAG index is cleared.

### Automatic RAG sync (010.2.2)

Embeddings are kept in sync with the folder contents automatically, whoever changes them — you via the API/CLI, an agent via the storage tools, or a person editing directly in the MinIO console. The unit of reindexing is a whole _scope_ (`knowledge/{role_slug}/` or `knowledge/shared/`): a rebuild re-lists, re-chunks, and re-embeds every file in the scope and replaces that scope's rows in `knowledge_chunk`. Two triggers feed one BullMQ queue (`knowledge-reindex`), and both run inside tcp-server:

1. **Write hook (fast path).** `StorageService` is the single chokepoint for all tcp-server-mediated writes; after any successful write/delete/restore/move/copy under a `knowledge/` prefix it enqueues a rebuild for the affected scope.
2. **Reconciliation poller (safety net).** A periodic in-process loop (interval `KNOWLEDGE_POLL_INTERVAL_MS`, default `60000`) fingerprints each scope's storage listing and enqueues a rebuild for any scope that has drifted from the fingerprint recorded at its last successful rebuild. This is what catches direct MinIO-console edits that never went through the write hook. Each running tcp-server instance polls independently; bumps are generation-guarded, so overlapping polls are harmless.

Restart-on-change is handled by a per-scope generation counter (`knowledge_index_state`): every trigger atomically bumps the counter and enqueues a job carrying the new value. The worker skips any job older than the current generation and aborts + re-enqueues if the generation changes mid-rebuild, so a burst of writes collapses into a single up-to-date rebuild with no half-indexed state. Because indexing is asynchronous, chunks may appear a moment after an upload rather than synchronously.

To force a rebuild of every scope of a company immediately (rather than waiting for the poller), use the manual trigger:

```bash
./tcp-cli.sh reindex-knowledge -c <company-slug-or-id>
# → POST /api/company/:companyId/knowledge/reindex (202 Accepted)
```

One role's scope can be rebuilt alone with `POST /api/role/:roleId/knowledge/reindex` (also 202). The web client's **Rebuild index** button uses these two routes.

To check a scope's indexing status (document/chunk counts, size, generation, last successful rebuild, and whether one is in progress), use:

```bash
./tcp-cli.sh get-knowledge-index-status -r <roleId>
# → GET /api/role/:roleId/knowledge/status

./tcp-cli.sh get-knowledge-index-status -c <company-slug-or-id>
# → GET /api/company/:companyId/knowledge/status (shared scope + every role)
```

To see the raw chunks a role's next prompt would retrieve — without spending
an LLM call — query the RAG index directly:

```bash
./tcp-cli.sh query-knowledge -r <roleId> -q "remote work policy"
# → GET /api/role/:roleId/knowledge/query?q=... (role chunks + company shared chunks)
```

`GET /api/company/:companyId/knowledge/query?q=...` searches the shared chunks only. The web client's test search uses both.

Deleting a role (either delete route) removes its knowledge files from storage first, then the role row, then its index state. The files are keyed by role slug, so without this a new role with the same slug would inherit them. If storage fails, the role is left intact.

```bash
# Upload a document to a role's knowledge base
./tcp-cli.sh store-knowledge -r <roleId> -s policy.md

# Upload a document to the company's shared knowledge
./tcp-cli.sh store-knowledge -c <companyId> -s handbook.md

# List stored documents
./tcp-cli.sh list-knowledge -r <roleId>
./tcp-cli.sh list-knowledge -c <companyId>

# Retrieve a document's content
./tcp-cli.sh get-knowledge -r <roleId> -f policy.md

# Remove a document by filename
./tcp-cli.sh delete-knowledge -r <roleId> -f policy.md

# Force a full RAG rebuild of every scope of a company
./tcp-cli.sh reindex-knowledge -c <companyId>
```

See [`tcp-cli.md` → knowledge management verbs](tcp-cli.md#list-knowledge) and [Agent Services → RAG](agent-services.md#rag-retrieval-augmented-generation) for full details.

---

## Downloading and uploading documents from the CLI

```bash
# Download a file from storage to the local filesystem
./tcp-cli.sh download-shared-document \
  --source acme/tasks/xyz/output/report.md \
  --target ~/Desktop/report.md        # optional; defaults to ./<filename>

# Upload a local file to storage
./tcp-cli.sh upload-shared-document \
  --source ./architecture.md \
  --target acme/knowledge/architect/architecture.md
```

Both commands write a JSON result to stdout and progress messages to stderr. See [tcp-cli.md](tcp-cli.md#download-shared-document) for full option details.

---

## Agent access via MCP

Agents interact with storage through the [tcp-mcp-storage](tcp-mcp-storage.md) MCP server rather than directly via the S3 API. The tools fall into four tiers:

- **Read-only exploration** — `describe_server`, `describe_folder`, `list_files`, `read_file`, `search_files`, `get_file_properties`, `get_file_summary`. Agents may browse and read anything in **their own company's** folder. Paths are taken relative to the company folder (`knowledge/shared/`), and a full key inside it works too. Another company's files can't be reached: a path that isn't already inside the caller's company folder is placed inside it, so it is simply not found.
- **Assignment-scoped working files** — `list_working_files`, `get_working_file_properties`, `get_working_file_summary`, `read_working_file`, `create_working_file`, `append_working_file`, `replace_in_working_file`, `delete_working_file`, `restore_working_file`, `rename_working_file`. The agent supplies **only a filename** (subdirectories allowed); the working-directory prefix is derived server-side from the caller's assignment (see below), so an agent can only write inside its own working area. `create_working_file` creates a new file (or replaces one entirely with `overwrite: true`) — the whole-file counterpart to `append_working_file` (add to a file) and `replace_in_working_file` (small in-place edit). In **qa mode** these are read-only and target the assignment under review — the mutating variants return a "not available in qa mode" message.
- **Company resources** — `list_resources`, `read_resource`, `write_resource`, `append_resource`, `replace_in_resource`. The agent supplies a path under `resources/`. Where reads look and where a write lands is decided server-side from the agent's mode (see [Company resources](#company-resources)).
- **Assignment-scoped materials** — `list_material_files`, `get_material_file_properties`, `read_material_file`. Exposes the caller's assignment's `materials`, resolved to concrete keys (`resolveArtifactKey`); `inline-text` materials are keyed by a synthetic `inline-N` name and read back as their literal content.

The permissive general **write** tools (`write_file`, `delete_file`, `restore_file`, `copy_file`, `move_file`) are no longer exposed to agents — the internal endpoints behind them remain for the knowledge API, storage proxy, and orchestration. See [tcp-mcp-storage.md](tcp-mcp-storage.md) for the full tool reference.

### Scope resolution

The scoped tools resolve their working prefix and materials via `GET /internal/agent/:agentId/storage-scope` (the `agentId` is injected by `McpClientService`, never model-supplied). tcp-server returns `{ mode, readOnly, companyPrefix, workingPrefix, materials, resources }`. `companyPrefix` (`{slug}/`) keeps the shared read tools inside the caller's company. `resources` is `{ mode, readPrefixes, writePrefix }`: the folders a resource is read from in order, and the one folder writes go to, or `null` when the agent may not change resources.

- `implement`/`plan` callers get their **own** assignment's working directory (`tasks/{taskId}/assignments/{orderIndex}/working/`, or `assignments/{assignmentId}/working/` for orphans), read/write.
- `qa` callers get the **target assignment**'s working directory, read-only, and the target's materials view.

Filenames are normalised and rejected if absolute, containing a `..` segment, or containing a segment that looks like a resolved storage-hierarchy path component (`tasks`, `assignments`, `materials`, `completed`, `working`) — so a resolved key can never escape the working prefix, and a full (or partial) storage key echoed back by the model is refused with a corrective error rather than silently concatenated onto the prefix. The assignment-presentation prompt itself always shows materials/expected outputs as their bare name/filename, never the resolved key, so the model has no reason to pass anything else.

## Internal storage-action endpoints

The full file-action surface (list, read, write, delete, restore, search, properties, copy, move, summary, exists) lives on `tcp-server` under `POST /internal/storage/*` (plus `GET /internal/storage/exists`), guarded by `X-Internal-Api-Key` rather than JWT — these are service-to-service endpoints backing `tcp-mcp-storage`'s MCP tools, not for direct CLI/human use. `POST /internal/storage/append` (read-modify-write that creates the file when absent, `created` in the response) and `POST /internal/storage/replace` (all-occurrence literal string replace, returning `count`) are both variants of `write` and re-use its validation/audit/origination plumbing. `StorageProxyController`'s JWT-guarded `GET/POST /api/storage` remains the human-facing generic get/put-by-key surface. `list` takes an `all` flag that lifts the 1,000-key cap, used for resource trees and for promotion. `delete`/`restore` are soft-delete (files move to `_deleted/`), matching the MCP tool semantics described above — `deleteKnowledgeFile` now delegates to the same soft-delete primitive rather than hard-deleting.
