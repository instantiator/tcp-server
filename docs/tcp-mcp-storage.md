# tcp-mcp-storage

**Status:** Implemented
**Port:** 3010
**Transport:** MCP Streamable HTTP — stateless, one session per request

`tcp-mcp-storage` is a NestJS MCP server that gives agents read-only exploration of the shared document store plus **assignment-scoped** working-file and material tools. It lives in `apps/tcp-mcp-storage/` and runs as a Docker Compose service alongside tcp-agent.

Each tool call creates a fresh MCP session (`McpServer` + `StreamableHTTPServerTransport`) so no state is shared across requests. The server exposes `GET /health` and `POST /mcp`.

This service no longer talks to MinIO directly — it's a thin HTTP proxy to `tcp-server`'s `POST /internal/storage/*` endpoints (guarded by `X-Internal-Api-Key`), which own the actual S3 client, path validation, soft-delete mechanics, content analysis, document validation, and audit recording. This service's job is purely the MCP `ToolResult` presentation layer: forwarding tool calls as HTTP requests and translating tcp-server's response (or error) into the text the LLM sees. Every mutating tool call is recorded as a properly-attributed audit event by tcp-server itself (carrying `originators.agent`, resolved via the `agentId` field each scoped tool declares in its schema — hidden from the LLM and injected by `McpClientService`'s `fixedArgs` mechanism, the same pattern used by `tcp-mcp-interactions`).

The permissive general write tools (`write_file`, `delete_file`, `restore_file`, `copy_file`, `move_file`) are no longer exposed to agents. In their place, the **working-file** tools take just a filename and derive the working-directory prefix server-side from the caller's assignment (`GET /internal/agent/:agentId/storage-scope`), so an agent can only write inside its own working area — read-only in qa mode. **Material** tools expose the assignment's resolved `materials`. See [shared-storage.md → Agent access via MCP](shared-storage.md#agent-access-via-mcp) for the scoping model.

See [shared-storage.md](shared-storage.md) for the full folder structure and authentication details. See [agent-services.md → MCP Servers](agent-services.md#mcp-servers) for how agents connect.

---

## Tools

Read-only exploration:

| Tool                                          | Signature                         | Description                                |
| --------------------------------------------- | --------------------------------- | ------------------------------------------ |
| [`describe_server`](#describe_server)         | `describe_server()`               | Overview of all tools and path conventions |
| [`describe_folder`](#describe_folder)         | `describe_folder(path)`           | Purpose of a folder by path prefix         |
| [`list_files`](#list_files)                   | `list_files(path?)`               | List files under a path prefix             |
| [`read_file`](#read_file)                     | `read_file(path)`                 | Read a file's text content by full key     |
| [`search_files`](#search_files)               | `search_files(prefix?, pattern?)` | Find files by path prefix and/or glob      |
| [`get_file_properties`](#get_file_properties) | `get_file_properties(path)`       | Metadata without reading the file body     |
| [`get_file_summary`](#get_file_summary)       | `get_file_summary(path)`          | Structural analysis of a file's content    |

Assignment-scoped working files (filename-only; write tools are read-only in qa mode):

| Tool                          | Signature                                            | Description                                                       |
| ----------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| `list_working_files`          | `list_working_files()`                               | List your working directory                                       |
| `get_working_file_properties` | `get_working_file_properties(filename)`              | Metadata for a working file                                       |
| `get_working_file_summary`    | `get_working_file_summary(filename)`                 | Structural summary of a working file (headings/keys/CSV columns)  |
| `read_working_file`           | `read_working_file(filename)`                        | Read a working file                                               |
| `create_working_file`         | `create_working_file(filename, content, overwrite?)` | Create a new file, or replace one entirely with `overwrite: true` |
| `append_working_file`         | `append_working_file(filename, content)`             | Append (creates the file if absent)                               |
| `replace_in_working_file`     | `replace_in_working_file(filename, find, replace)`   | Replace every occurrence of `find`                                |
| `delete_working_file`         | `delete_working_file(filename)`                      | Soft-delete a working file                                        |
| `restore_working_file`        | `restore_working_file(filename)`                     | Restore a soft-deleted working file                               |
| `rename_working_file`         | `rename_working_file(filename, newFilename)`         | Rename a working file within the working directory                |

Assignment-scoped materials (read-only):

| Tool                           | Signature                                | Description                           |
| ------------------------------ | ---------------------------------------- | ------------------------------------- |
| `list_material_files`          | `list_material_files()`                  | List the assignment's materials       |
| `get_material_file_properties` | `get_material_file_properties(filename)` | Metadata for a material               |
| `read_material_file`           | `read_material_file(filename)`           | Read a material (inline text or file) |

---

## `describe_server`

Returns a markdown overview of the storage service: available tools and path conventions.

**Arguments:** none

**Returns:** Markdown text listing all tools and a note on path format.

**Usage pattern:** useful when an agent wants an orientation on what the storage server offers. It is not a precondition for anything.

**Tool-schema gating:** removed in 010.2.8.2 — all tools in this table are bound to the model from turn 1 (subject to mode filtering; see [Agent Services → Enabling MCP tools](agent-services.md#enabling-mcp-tools-for-a-role) and [ADR-013 Amendments](ADRs/ADR-013-prompt-assembly-context-management.md#amendments-as-implemented-010282)), not gated behind a `describe_server` call.

---

## `describe_folder`

Returns a canned description of what a given folder path is for, based on the [ADR-007](ADRs/ADR-007-shared-company-storage.md) folder layout.

**Arguments:**

| Parameter | Type   | Required | Description                                                      |
| --------- | ------ | -------- | ---------------------------------------------------------------- |
| `path`    | string | yes      | Folder path prefix to describe (e.g. `acme/tasks/abc/completed`) |

**Returns:** A short prose description of the folder's purpose and conventions.

**Recognised path patterns** (matched in this order — the first hit wins):

| Pattern                                    | Description                                                      |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `.../tasks/.../materials`                  | Task inputs — read-only after task creation                      |
| `.../tasks/.../completed` (not assignment) | The task's final deliverables                                    |
| `.../working`                              | An assignment's private working area                             |
| `.../assignments/.../completed`            | Files promoted from an assignment's working area once QA accepts |
| `.../knowledge/...`                        | RAG source documents — treat as read-only from agents            |
| `.../audit/...`                            | Append-only JSONL audit records — do not modify                  |

Unrecognised paths return a generic message and suggest using `list_files` to explore.
The descriptions themselves live in `apps/tcp-mcp-storage/src/prompts.jsonc`.

---

## `list_files`

Lists all files (object keys) under a given path prefix, excluding soft-deleted files (those under `_deleted/`).

**Arguments:**

| Parameter | Type   | Required | Description                                                 |
| --------- | ------ | -------- | ----------------------------------------------------------- |
| `path`    | string | no       | Prefix to list under. Omit to list all files in the bucket. |

**Returns:** JSON array of file entries:

```json
[
  {
    "key": "acme/tasks/abc/completed/report.md",
    "size": 4096,
    "lastModified": "2026-06-01T12:00:00.000Z"
  }
]
```

An empty array is returned if no files match the prefix. Soft-deleted files (prefixed with `_deleted/`) are always excluded.

---

## `read_file`

Reads the full text content of a single file.

**Arguments:**

| Parameter | Type   | Required | Description                                                    |
| --------- | ------ | -------- | -------------------------------------------------------------- |
| `path`    | string | yes      | Object key to read (e.g. `acme/tasks/abc/materials/brief.txt`) |

**Returns:** The file's text content, or `"File not found: {path}"` if the key does not exist.

**Path validation:** The path must not contain `..`. Invalid paths return an error message immediately without calling MinIO.

---

## Assignment-scoped working files

These tools operate on the caller's own working directory (or, in qa mode, the assignment under review — read-only). The agent supplies only a **filename** relative to that directory (subdirectories allowed); `agentId` is injected by `McpClientService`. The prefix is resolved via `GET /internal/agent/:agentId/storage-scope`. A filename that is absolute, contains a `..` segment, or contains a segment that looks like a resolved storage-hierarchy path component (`tasks`, `assignments`, `materials`, `completed`, `working`) is rejected before any HTTP call — the latter guards against a model echoing back a resolved storage key instead of the bare filename it was shown, which would otherwise silently double-nest under the working prefix.

- **`list_working_files()`** — lists the working directory (same entry shape as `list_files`).
- **`get_working_file_properties(filename)`** — metadata for a working file.
- **`get_working_file_summary(filename)`** — structural summary without reading the whole file: headings, top-level keys, or (for CSV) column names and row count, depending on format. Cheaper than `read_working_file` for a large or unfamiliar file.
- **`read_working_file(filename)`** — reads a working file; friendly error if missing.
- **`create_working_file(filename, content, overwrite?)`** — creates a new file with `content`, or replaces one entirely when `overwrite: true`. Fails with a corrective warning (naming `overwrite: true` and `append_working_file`) if the file exists and `overwrite` isn't set. The whole-file counterpart to `append_working_file` (add to a file) and `replace_in_working_file` (small in-place edit) — use it for a brand-new file or a full rewrite.
- **`append_working_file(filename, content)`** — appends `content`, **creating the file if absent**. The resulting document is validated (same rules as a direct write); returns `"Created working file: {filename}"` or `"Appended to working file: {filename}"`. In qa mode: `"Not available in qa mode…"`.
- **`replace_in_working_file(filename, find, replace)`** — replaces **all** occurrences of the literal string `find`, validates the result, and returns `"Replaced {N} occurrence(s) in working file: {filename}"`. Errors if the file is missing or `find` occurs zero times.
- **`delete_working_file(filename)`** / **`restore_working_file(filename)`** — soft-delete and restore, using the same `_deleted/` mechanism as the internal `delete`/`restore` endpoints.
- **`rename_working_file(filename, newFilename)`** — renames a file within the working directory; both names are validated the same way, so a rename can't move a file out of the working area.

Backed by `POST /internal/storage/write` (`create_working_file`, returns `key`/`size`), `POST /internal/storage/append` (returns `created`) and `POST /internal/storage/replace` (returns `count`), plus the existing `list`/`read`/`properties`/`delete`/`restore` endpoints.

---

## Assignment-scoped materials

Read-only access to the materials handed to the caller's assignment, resolved server-side to concrete storage keys (`resolveArtifactKey`). `inline-text` materials are keyed by a stable synthetic `inline-N` name and returned as literal content.

- **`list_material_files()`** — lists materials as `{ name, kind }` where `kind` is `file` or `inline-text`.
- **`get_material_file_properties(filename)`** — metadata for a material (synthesised for inline text).
- **`read_material_file(filename)`** — reads a material by name (the literal text for inline-text materials).

---

## `search_files`

Lists files matching a path prefix and/or a glob pattern.

**Arguments:**

| Parameter | Type   | Required | Description                                                             |
| --------- | ------ | -------- | ----------------------------------------------------------------------- |
| `prefix`  | string | no       | Path prefix to search under. Omit to search the whole bucket.           |
| `pattern` | string | no       | Glob pattern to match against file names (e.g. `*.md`, `report-*.json`) |

**Returns:** JSON array in the same format as `list_files`. Soft-deleted files are excluded.

**Pattern matching:** The glob is matched against the base filename only (not the full path). `*` matches any sequence of characters; `?` matches a single character. If no pattern is given, all files under the prefix are returned.

---

## `get_file_properties`

Returns metadata for a file without reading its content body.

**Arguments:**

| Parameter | Type   | Required | Description           |
| --------- | ------ | -------- | --------------------- |
| `path`    | string | yes      | Object key to inspect |

**Returns:** JSON object:

```json
{
  "exists": true,
  "key": "acme/tasks/abc/completed/report.md",
  "size": 4096,
  "contentType": "text/markdown",
  "lastModified": "2026-06-01T12:00:00.000Z"
}
```

Returns `{ "exists": false }` if the file does not exist.

---

## `get_file_summary`

Returns a structural analysis of a file's content without requiring LLM processing. Format is detected from the file extension.

**Arguments:**

| Parameter | Type   | Required | Description           |
| --------- | ------ | -------- | --------------------- |
| `path`    | string | yes      | Object key to analyse |

**Returns:** JSON object whose structure depends on the detected format:

| Format             | Detected by       | Extracted                                                                             |
| ------------------ | ----------------- | ------------------------------------------------------------------------------------- |
| JSON object        | `.json`, `.jsonc` | `format`, `keys` (top-level property names), `valueTypes`                             |
| JSON array         | `.json`, `.jsonc` | `format: "json-array"`, `length`                                                      |
| Markdown           | `.md`             | `format: "markdown"`, `headings` (text + level), `wordCount`                          |
| CSV                | `.csv`            | `format: "csv"`, `columns` (header row), `rowCount` (data rows, excluding the header) |
| Plain text / other | anything else     | `format: "text"`, `lineCount`, `wordCount`, `firstLine`                               |

Returns `"File not found: {path}"` if the key does not exist.

---

## Path conventions

Paths are object keys relative to the bucket root. They follow the ADR-007 structure:

```
{company_slug}/{area}/{...}
```

Do not include a leading `/`. Examples:

| Path                                                  | Meaning                                |
| ----------------------------------------------------- | -------------------------------------- |
| `acme/tasks/abc123/materials/brief.md`                | A material supplied with task `abc123` |
| `acme/tasks/abc123/assignments/2/working/analysis.md` | Step 2's agent's working file          |
| `acme/tasks/abc123/completed/report.md`               | A final deliverable of task `abc123`   |
| `acme/knowledge/analyst/policies.md`                  | RAG source doc for the `analyst` role  |

See [shared-storage.md → Folder structure](shared-storage.md#folder-structure)
for the full tree.

### Soft-delete prefix

`_deleted/` is a reserved prefix at the bucket root. Deleted files are stored under `_deleted/{original_path}`. Do not write to or read from `_deleted/` directly.

---

## Deferred

| Item                    | Description                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| MinIO OIDC SSO          | Zitadel console login for the MinIO UI — deferred                                                                |
| MinIO bucket versioning | Would provide true versioning instead of the `_deleted/` soft-delete prefix; configurable per company when added |
| Audit log JSONL export  | Archival export of audit events to MinIO JSONL files — deferred (see ADR-008)                                    |
