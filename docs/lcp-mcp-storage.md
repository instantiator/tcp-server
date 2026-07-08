# lcp-mcp-storage

**Status:** Implemented
**Port:** 3010
**Transport:** MCP Streamable HTTP — stateless, one session per request

`lcp-mcp-storage` is a NestJS MCP server that gives agents read/write access to the shared document store. It lives in `apps/lcp-mcp-storage/` and runs as a Docker Compose service alongside lcp-agent.

Each tool call creates a fresh MCP session (`McpServer` + `StreamableHTTPServerTransport`) so no state is shared across requests. The server exposes `GET /health` and `POST /mcp`.

Since `docs/prompts/009.4 - doc type validations.md`, this service no longer talks to MinIO directly — it's a thin HTTP proxy to `lcp-server`'s `POST /internal/storage/*` endpoints (guarded by `X-Internal-Api-Key`), which own the actual S3 client, path validation, soft-delete mechanics, content analysis, document validation, and audit recording. This service's job is purely the MCP `ToolResult` presentation layer: forwarding tool calls as HTTP requests and translating lcp-server's response (or error) into the text the LLM sees. Every write/delete/restore/copy/move tool call is recorded as a properly-attributed audit event by lcp-server itself (carrying `originators.agent`, resolved via the `agentId` field each of those tools declares in its schema — hidden from the LLM and injected by `McpClientService`'s `fixedArgs` mechanism, the same pattern used by `lcp-mcp-interactions`).

See [shared-storage.md](shared-storage.md) for the full folder structure and authentication details. See [agent-services.md → MCP Servers](agent-services.md#mcp-servers) for how agents connect.

---

## Tools

| Tool                                          | Signature                               | Description                                |
| --------------------------------------------- | --------------------------------------- | ------------------------------------------ |
| [`describe_server`](#describe_server)         | `describe_server()`                     | Overview of all tools and path conventions |
| [`describe_folder`](#describe_folder)         | `describe_folder(path)`                 | Purpose of a folder by path prefix         |
| [`list_files`](#list_files)                   | `list_files(path?)`                     | List files under a path prefix             |
| [`read_file`](#read_file)                     | `read_file(path)`                       | Read a file's text content                 |
| [`write_file`](#write_file)                   | `write_file(path, content, overwrite?)` | Create or overwrite a file                 |
| [`delete_file`](#delete_file)                 | `delete_file(path)`                     | Soft-delete a file (restorable)            |
| [`restore_file`](#restore_file)               | `restore_file(path)`                    | Restore a soft-deleted file                |
| [`search_files`](#search_files)               | `search_files(prefix?, pattern?)`       | Find files by path prefix and/or glob      |
| [`get_file_properties`](#get_file_properties) | `get_file_properties(path)`             | Metadata without reading the file body     |
| [`copy_file`](#copy_file)                     | `copy_file(source, destination)`        | Copy a file within the bucket              |
| [`move_file`](#move_file)                     | `move_file(source, destination)`        | Move (rename) a file within the bucket     |
| [`get_file_summary`](#get_file_summary)       | `get_file_summary(path)`                | Structural analysis of a file's content    |

---

## `describe_server`

Returns a markdown overview of the storage service: available tools and path conventions.

**Arguments:** none

**Returns:** Markdown text listing all tools and a note on path format.

**Usage pattern:** Agents should call this first when they discover the storage server is available. Prompt part 3 directs agents to do this automatically.

**Tool-schema gating:** all other tools in this table are only bound to the model after `describe_server` has been called, and stay bound for a small number of iterations before being hidden again (see [ADR-013 Amendments](ADRs/ADR-013-prompt-assembly-context-management.md#amendments-as-implemented-0086)). Calling any other tool before `describe_server` will fail because the LLM was never given that tool's schema in the first place.

---

## `describe_folder`

Returns a canned description of what a given folder path is for, based on the [ADR-007](ADRs/ADR-007-shared-company-storage.md) folder layout.

**Arguments:**

| Parameter | Type   | Required | Description                                                   |
| --------- | ------ | -------- | ------------------------------------------------------------- |
| `path`    | string | yes      | Folder path prefix to describe (e.g. `acme/tasks/abc/output`) |

**Returns:** A short prose description of the folder's purpose and conventions.

**Recognised path patterns:**

| Pattern                       | Description                                           |
| ----------------------------- | ----------------------------------------------------- |
| `.../tasks/.../materials`     | Task inputs — read-only after task creation           |
| `.../tasks/.../output`        | Agent working area during task execution              |
| `.../knowledge/...`           | RAG source documents — treat as read-only from agents |
| `.../finished/reports`        | Reviewed report artefacts                             |
| `.../finished/specifications` | Reviewed technical/functional specs                   |
| `.../finished/designs`        | Reviewed design documents                             |
| `.../finished/code`           | Reviewed code artefacts                               |
| `.../finished/other`          | Stable artefacts not in a named category              |
| `.../audit/...`               | Append-only JSONL audit records — do not modify       |

Unrecognised paths return a generic message and suggest using `list_files` to explore.

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
    "key": "acme/tasks/abc/output/report.md",
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

| Parameter | Type   | Required | Description                                                 |
| --------- | ------ | -------- | ----------------------------------------------------------- |
| `path`    | string | yes      | Object key to read (e.g. `acme/tasks/abc/output/notes.txt`) |

**Returns:** The file's text content, or `"File not found: {path}"` if the key does not exist.

**Path validation:** The path must not contain `..`. Invalid paths return an error message immediately without calling MinIO.

---

## `write_file`

Creates or overwrites a file with the given text content.

**Arguments:**

| Parameter   | Type    | Required | Default | Description                                             |
| ----------- | ------- | -------- | ------- | ------------------------------------------------------- |
| `path`      | string  | yes      | —       | Object key to write                                     |
| `content`   | string  | yes      | —       | Text content to write                                   |
| `overwrite` | boolean | no       | `false` | If `false`, refuses to write if the file already exists |

**Returns:** `"Written {N} bytes to {path}"` on success.

**Overwrite safety:** When `overwrite` is `false` (the default), the tool checks whether the file exists before writing. If it does, it returns `"File already exists at {path}. Set overwrite: true to replace it."` — the agent must explicitly opt in to overwriting.

**Path validation:** The path must not contain `..`.

---

## `delete_file`

Soft-deletes a file by moving it to `_deleted/{original_path}`. The file can be restored with `restore_file`.

**Arguments:**

| Parameter | Type   | Required | Description          |
| --------- | ------ | -------- | -------------------- |
| `path`    | string | yes      | Object key to delete |

**Returns:** `"Deleted {path} (restorable with restore_file)"` on success, or `"File not found: {path}"` if the key does not exist.

**Soft delete:** Files are copied to `_deleted/{path}` then removed from the original location. This means deleted files are not visible to `list_files` or `search_files` but can be recovered. It is not full MinIO versioning — if the same path is deleted twice without restoring, the second delete replaces the first in `_deleted/`.

---

## `restore_file`

Restores a previously soft-deleted file back to its original path.

**Arguments:**

| Parameter | Type   | Required | Description                                            |
| --------- | ------ | -------- | ------------------------------------------------------ |
| `path`    | string | yes      | Original object key (not the `_deleted/` prefixed key) |

**Returns:** `"Restored {path}"` on success, or `"No soft-deleted file found at {path}"` if nothing exists under `_deleted/{path}`.

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
  "key": "acme/tasks/abc/output/report.md",
  "size": 4096,
  "contentType": "text/markdown",
  "lastModified": "2026-06-01T12:00:00.000Z"
}
```

Returns `{ "exists": false }` if the file does not exist.

---

## `copy_file`

Copies a file to a new location within the same bucket.

**Arguments:**

| Parameter     | Type   | Required | Description            |
| ------------- | ------ | -------- | ---------------------- |
| `source`      | string | yes      | Source object key      |
| `destination` | string | yes      | Destination object key |

**Returns:** `"Copied {source} → {destination}"` on success.

**Path validation:** Both paths must not contain `..`. Returns `"Source file not found: {source}"` if the source does not exist.

---

## `move_file`

Moves (renames) a file within the bucket by copying then deleting the original.

**Arguments:**

| Parameter     | Type   | Required | Description            |
| ------------- | ------ | -------- | ---------------------- |
| `source`      | string | yes      | Source object key      |
| `destination` | string | yes      | Destination object key |

**Returns:** `"Moved {source} → {destination}"` on success.

---

## `get_file_summary`

Returns a structural analysis of a file's content without requiring LLM processing. Format is detected from the file extension.

**Arguments:**

| Parameter | Type   | Required | Description           |
| --------- | ------ | -------- | --------------------- |
| `path`    | string | yes      | Object key to analyse |

**Returns:** JSON object whose structure depends on the detected format:

| Format             | Detected by       | Extracted                                                    |
| ------------------ | ----------------- | ------------------------------------------------------------ |
| JSON object        | `.json`, `.jsonc` | `format`, `keys` (top-level property names), `valueTypes`    |
| JSON array         | `.json`, `.jsonc` | `format: "json-array"`, `length`                             |
| Markdown           | `.md`             | `format: "markdown"`, `headings` (text + level), `wordCount` |
| Plain text / other | anything else     | `format: "text"`, `lineCount`, `wordCount`, `firstLine`      |

Returns `"File not found: {path}"` if the key does not exist.

---

## Path conventions

Paths are object keys relative to the bucket root. They follow the ADR-007 structure:

```
{company_slug}/{area}/{...}
```

Do not include a leading `/`. Examples:

| Path                                      | Meaning                               |
| ----------------------------------------- | ------------------------------------- |
| `acme/tasks/abc123/output/analysis.md`    | Agent output for task `abc123`        |
| `acme/knowledge/analyst/policies.md`      | RAG source doc for the `analyst` role |
| `acme/finished/reports/abc123/summary.md` | Promoted stable report                |

### Soft-delete prefix

`_deleted/` is a reserved prefix at the bucket root. Deleted files are stored under `_deleted/{original_path}`. Do not write to or read from `_deleted/` directly.

---

## Deferred

| Item                    | Description                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| MinIO OIDC SSO          | Keycloak console login for the MinIO UI — deferred                                                               |
| MinIO bucket versioning | Would provide true versioning instead of the `_deleted/` soft-delete prefix; configurable per company when added |
| Audit log JSONL export  | Archival export of audit events to MinIO JSONL files — deferred (see ADR-008)                                    |
