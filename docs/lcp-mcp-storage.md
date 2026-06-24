# lcp-mcp-storage

**Status:** Implemented (real MinIO integration)
**Port:** 3010
**Transport:** MCP Streamable HTTP — stateless, one session per request

`lcp-mcp-storage` is a NestJS MCP server that gives agents read/write access to the shared MinIO object store. It lives in `apps/lcp-mcp-storage/` and runs as a Docker Compose service alongside lcp-agent.

Each tool call creates a fresh MCP session (`McpServer` + `StreamableHTTPServerTransport`) so no state is shared across requests. The server exposes `GET /health` and `POST /mcp`.

See [shared-storage.md](shared-storage.md) for the full folder structure and authentication details. See [agent-services.md → MCP Servers](agent-services.md#mcp-servers) for how agents connect.

---

## Tools

| Tool                                  | Signature                   | Description                                |
| ------------------------------------- | --------------------------- | ------------------------------------------ |
| [`describe_server`](#describe_server) | `describe_server()`         | Overview of all tools and path conventions |
| [`describe_folder`](#describe_folder) | `describe_folder(path)`     | Purpose of a folder by path prefix         |
| [`list_files`](#list_files)           | `list_files(path?)`         | List files under a path prefix             |
| [`read_file`](#read_file)             | `read_file(path)`           | Read a file's text content                 |
| [`write_file`](#write_file)           | `write_file(path, content)` | Create or overwrite a file                 |
| [`delete_file`](#delete_file)         | `delete_file(path)`         | Permanently delete a file                  |

---

## `describe_server`

Returns a markdown overview of the storage service: available tools and path conventions.

**Arguments:** none

**Returns:** Markdown text listing all tools and a note on path format.

**Usage pattern:** Agents should call this first when they discover the storage server is available, before calling any other tool. Prompt part 3 directs agents to do this automatically.

---

## `describe_folder`

Returns a canned description of what a given folder path is for, based on the [ADR-007](ADRs/ADR-007-shared-company-storage.md) folder layout. Useful when an agent is exploring what it can read or write.

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

Lists all files (object keys) under a given path prefix.

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

An empty array is returned if no files match the prefix.

---

## `read_file`

Reads the full text content of a single file.

**Arguments:**

| Parameter | Type   | Required | Description                                                 |
| --------- | ------ | -------- | ----------------------------------------------------------- |
| `path`    | string | yes      | Object key to read (e.g. `acme/tasks/abc/output/notes.txt`) |

**Returns:** The file's text content, or `"File not found: {path}"` if the key does not exist.

Only text files are supported. Binary files (images, PDFs) will return garbled content.

---

## `write_file`

Creates or overwrites a file with the given text content.

**Arguments:**

| Parameter | Type   | Required | Description           |
| --------- | ------ | -------- | --------------------- |
| `path`    | string | yes      | Object key to write   |
| `content` | string | yes      | Text content to write |

**Returns:** `"Written: {path}"` on success, or an error message if the path is invalid.

**Path validation:** the path must be non-empty and must not contain `..`. All other paths are accepted.

> **Note:** There is currently no overwrite confirmation check. If the object already exists it is silently replaced. A soft confirmation prompt (checking whether the file exists before writing) is a planned improvement — see [Known gaps](#known-gaps).

---

## `delete_file`

Permanently deletes a file from the object store.

**Arguments:**

| Parameter | Type   | Required | Description          |
| --------- | ------ | -------- | -------------------- |
| `path`    | string | yes      | Object key to delete |

**Returns:** `"Deleted: {path}"` on success, or an error message if the path is invalid.

**Path validation:** same as `write_file` — must be non-empty, no `..`.

> **Note:** Deletion is currently permanent. MinIO bucket versioning (which would allow recovery) is not yet enabled. See [Known gaps](#known-gaps).

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

---

## Known gaps

The following items from the original plan are not yet implemented:

| Gap                       | Description                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Audit logging             | Tool calls should write `tool_call` / `tool_result` rows to `audit_event`. The server currently has no DB connection.             |
| Overwrite safety          | `write_file` should check whether the target exists and prompt the agent to confirm before clobbering it.                         |
| Soft delete               | `delete_file` should use MinIO versioning (creating a delete marker) rather than a hard delete. Bucket versioning is not enabled. |
| `search_files`            | Pattern-match files by name/path prefix — not yet implemented.                                                                    |
| `get_file_properties`     | Return metadata (size, content type, last modified) without reading the file body — not yet implemented.                          |
| `copy_file` / `move_file` | Copy or rename files within the bucket — not yet implemented.                                                                     |
| `summarise_file`          | LLM-generated summary of a file's content — not yet implemented.                                                                  |
