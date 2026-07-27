# ADR-007: Shared Company Storage

Status: Partially Implemented

## Context

Each LCP company needs a shared storage facility — a common filesystem accessible to all agents in that company. It stores:

- Files created by agents during task execution (code, documents, designs, etc.)
- Supporting materials submitted by users when creating a task
- Exported audit log files (see [ADR-008](./ADR-008-audit-logging.md))
- Open Knowledge Format (OKF) knowledge base source files (see [ADR-006](./ADR-006-agent-memory-architecture.md))

Requirements:

- Per-company isolation (agents must not access another company's files)
- Versioning (to support overwrite/delete safety without hard ACLs)
- Accessible via MCP (the agent loop uses MCP tools to read and write files)
- Self-hostable (LCP must run on any server via Docker Compose)

## Options

| Option                                 | Versioning            | Per-company isolation      | Self-hosted | Notes                                                                                               |
| -------------------------------------- | --------------------- | -------------------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| **Filesystem + MCP filesystem server** | ✗                     | By directory convention    | ✓           | Simplest; adequate for a single-host deployment; no formal access control or versioning             |
| **MinIO (S3-compatible, Docker)**      | ✓ (bucket versioning) | ✓ (one bucket per company) | ✓           | S3-compatible; per-company bucket = natural isolation; versioning built-in; S3 MCP server available |
| **PostgreSQL large objects**           | ✓ (via DB history)    | ✓ (by query)               | ✓           | No extra service; not designed for large file storage; poor ergonomics for file-like access         |
| **Cloud object storage (S3, GCS)**     | ✓                     | ✓ (bucket policies)        | ✗           | Best for production scale; requires cloud credentials; not self-hostable                            |

## Decision

**MinIO** running as a Docker Compose service.

MinIO is S3-compatible, lightweight, and self-hostable. Per-company S3 buckets provide natural isolation. Versioning (enabled on creation) means overwritten or deleted files are not permanently lost — the orchestrator's soft "confirm before overwrite/delete" check (see below) is a first line of defence; versioning is the safety net.

### Bucket structure

```
{company_slug}/          ← one MinIO bucket per company
  tasks/
    {task_id}/
      materials/         ← supporting materials submitted with the task
      output/            ← files created by agents during the task
  knowledge/
    {role_name}/         ← OKF knowledge base source files for a role
  finished/              ← stable artefacts promoted from tasks/*/output/
    {category}/          ← reports | specifications | designs | code | other
      {task_id}/
        {filename}
  audit/
    {task_id}/
      {step_id}.jsonl    ← exported audit log per task step (see ADR-008)
```

Agents write to `tasks/{task_id}/output/` during execution. When a task completes, the reviewing agent (or orchestrator) copies finalised artefacts into `finished/{category}/{task_id}/`. This keeps in-progress working files isolated from stable outputs that other agents may read.

### Storage MCP server

Agents access company storage via a **storage MCP server** (S3-compatible). Tools:

| Tool                        | Description                                                         |
| --------------------------- | ------------------------------------------------------------------- |
| `read_file(path)`           | Read a file from the company bucket                                 |
| `write_file(path, content)` | Write or overwrite a file                                           |
| `list_files(prefix?)`       | List files under a path prefix                                      |
| `delete_file(path)`         | Delete a file (creates a delete marker; recoverable via versioning) |

The storage MCP server is scoped to the company bucket at startup — it cannot access other companies' buckets.

> **Note (008.6, superseded 010.2.6/010.2.8.2):** the four-tool table above is superseded — `write_file`/`delete_file` were replaced by assignment-scoped working/material tools in 010.2.6, and the describe-then-reveal tool-schema gating referenced here was itself removed in 010.2.8.2 (all mode-filtered tools are now bound from turn 1). See the [010.2.6 amendment](#amendments-as-implemented-01026) below for the actual current tool set, and [ADR-013 Amendments](ADR-013-prompt-assembly-context-management.md#amendments-as-implemented-010282) for the gating removal.

### Agent access and overwrite safety

Agents are granted access to the full company bucket (no hard per-agent ACL). The orchestrator is responsible for a **soft confirmation check**: before the agent calls `write_file` or `delete_file` on a path that already exists, a tool annotation prompts the agent to confirm its intent. This is enforced at the MCP server level (not by the agent), keeping the safety check consistent regardless of which model is running.

## Consequences

- MinIO is added to Docker Compose (see [ADR-009](./ADR-009-containerization-strategy.md))
- MinIO bucket is created automatically per company when the company is created via the API
- Company bucket name derived from `company.slug` (URL-safe, unique)
- Task supporting materials are uploaded via the lcp-server API and stored in `tasks/{task_id}/materials/` before the task enters the `planning` state

## Open Questions / Assumptions

- MinIO access credentials (access key + secret key) stored as environment variables; never in code
- Large file support: MinIO handles multi-part uploads for files > 5 MB automatically via the S3 SDK; the MCP server should use the S3 SDK directly rather than buffering large files in memory

## Amendments as implemented (009.4) — storage centralization and write-time validation

- **Storage abstraction**: `lcp-server` now exposes an abstract `StorageService` (`apps/lcp-server/src/storage/storage.service.ts`), implemented today by `MinioStorageAdapter`. This is the extension point for future backends (e.g. Google Drive) this ADR's "self-hostable" requirement didn't originally anticipate needing to swap out. `lcp-mcp-storage`'s `StorageToolsService` no longer talks to MinIO directly at all — it's a thin HTTP proxy to `lcp-server`'s `/internal/storage/*` endpoints, which own the real S3 client, path validation, content analysis, and audit recording. This centralises what was previously two independent, differently-configured S3 clients.
- **Delete semantics unified to soft-delete everywhere**, including the knowledge-base delete path (`deleteKnowledgeFile`, previously a hard delete) — now a thin wrapper over the same `deleteFile`/`_deleted/`-prefix mechanism the general file tools already used. Deliberate groundwork for planned RAG-consistency work, where restoring a knowledge file should trigger re-chunking.
- **Write-time document validation**: writes now go through format-specific validators (`libs/lcp-shared/src/storage/validation/`) before being accepted — JSON, YAML, OKF Markdown, plain Markdown, XML, CSV. A standalone `POST /api/storage/validate` endpoint (+ `validate-shared-document` CLI verb) re-checks documents already in storage, since a user could bypass lcp-server and write to MinIO directly. See `docs/shared-storage.md#write-validation`.
- **Bucket-layout note (pre-existing, not changed by this pass)**: this ADR's "one MinIO bucket per company" design (line 39 above) was already diverged from in the actual implementation — both the old and new storage code use a single shared bucket (default `lcp`) with the company slug as a key prefix, not a separate bucket per company. This pass did not attempt to reconcile that divergence; flagging it here since it hadn't been written down anywhere before.

## Amendments as implemented (010.2.1) — knowledge folders and knowledge API

- **Knowledge folders are slug-based, with a company-wide `shared/` scope**: the bucket layout's `knowledge/{role_name}/` (line 45 above) is now `knowledge/{role_slug}/`, plus a new `knowledge/shared/` folder for knowledge shared across all of a company's roles. `shared` is a reserved role slug — `DbService.setRole` rejects it with a 400 on both create and update — so it can never collide with an actual role's folder.
- **`StorageService`'s knowledge-file methods are scope-based, not role-name-based**: `putKnowledgeFile`/`listKnowledgeFiles`/`getKnowledgeFile`/`deleteKnowledgeFile` now take a `KnowledgeScope` (`{ companySlug, roleSlug: string | null }`, `null` = shared) instead of a role name, implemented via `knowledgeScopeKey`/`knowledgeScopePrefix` (`apps/lcp-server/src/storage/storage-keys.ts`).
- **`KnowledgeChunk.roleId` is nullable**: `null` marks a chunk indexed from `knowledge/shared/`. The `AllowSharedKnowledgeChunks` migration truncates the existing `knowledge_chunk` table (old rows referenced the now-unreachable name-based paths) and adds a `(companyId, documentPath)` index alongside the existing `(companyId, roleId)`/`(roleId, documentPath)` indexes.
- **`RoleDocumentService`/`RoleDocumentController` were replaced by `KnowledgeService`/`KnowledgeController`**, which handle both role and company (shared) scopes under `/api/role/:roleId/knowledge` and `/api/company/:companyId/knowledge` respectively. The old `/api/role/:roleId/documents` routes are gone. `lcp-cli`'s `store-role-documents`/`list-role-documents`/`remove-role-documents` were replaced by `store-knowledge`/`list-knowledge`/`get-knowledge`/`delete-knowledge`, each taking a single `--role`/`--company` slug-or-id flag. `upload-shared-document`/`download-shared-document`/`validate-shared-document` (arbitrary-path storage, unrelated to the knowledge base) are unchanged.
- **No RAG retrieval changes in this pass**: search still scopes to a single `roleId`; searching a role's chunks _and_ the company's shared chunks together is deferred to the next piece of work (embedding-sync/scoped-retrieval).

## Amendments as implemented (010.2.6) — assignment-scoped storage tools

- **The permissive general write tools are no longer exposed to agents.** `write_file`, `delete_file`, `restore_file`, `copy_file`, and `move_file` are removed from the MCP toolset (their `/internal/storage/*` endpoints remain, used by the knowledge API, storage proxy, and orchestration). The old "soft confirmation check before overwrite" model (line 74 above) is superseded: agents no longer address arbitrary keys for writes at all.
- **New assignment-scoped tools.** Working files — `list_working_files`, `get_working_file_properties`, `read_working_file`, `append_working_file`, `replace_in_working_file`, `delete_working_file`, `restore_working_file` — take only a filename; the working-directory prefix is derived server-side from the caller's assignment via `GET /internal/agent/:agentId/storage-scope` (`agentId` injected by `McpClientService`). Materials — `list_material_files`, `get_material_file_properties`, `read_material_file` — expose the assignment's `materials` resolved via `resolveArtifactKey`, with `inline-text` returned as literal content. `implement`/`plan` callers get their own working directory (read/write); `qa` callers get the target assignment's, read-only. Filenames that are absolute or contain `..` are rejected so a resolved key can never escape the working prefix.
- **Read-only exploration is retained**: `describe_server`, `describe_folder`, `list_files`, `read_file`, `search_files`, `get_file_properties`, `get_file_summary` still let agents browse shared storage by full key.
- **Two new internal primitives** back the working tools: `POST /internal/storage/append` (read-modify-write, creates on absent, returns `created`) and `POST /internal/storage/replace` (all-occurrence literal replace, returns `count`) — both variants of `write`, reusing its validation/audit/origination plumbing.
