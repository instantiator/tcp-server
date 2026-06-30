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
    {role_name}/         ← OKF Markdown documents used for RAG indexing
  finished/
    {category}/          ← reports | specifications | designs | code | other
      {task_id}/
        {filename}       ← stable artefacts promoted from tasks/*/output/
  audit/
    {task_id}/
      {step_id}.jsonl    ← append-only audit log per task step
```

### Folder purposes

| Path                        | Written by                     | Read by                   | Notes                                                                                                |
| --------------------------- | ------------------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `tasks/{id}/materials/`     | lcp-server (task creation)     | Agents (read-only)        | Task inputs submitted by the user                                                                    |
| `tasks/{id}/output/`        | Agents                         | Agents, orchestrator      | Working files created during execution                                                               |
| `knowledge/{role}/`         | lcp-cli `store-role-documents` | lcp-server (RAG indexing) | Source documents for RAG; see [Agent Services](agent-services.md#rag-retrieval-augmented-generation) |
| `finished/{category}/{id}/` | Reviewing agent / orchestrator | All agents                | Stable artefacts promoted on task completion                                                         |
| `audit/{id}/`               | lcp-agent (planned)            | Operations tooling        | Append-only JSONL audit records per task step                                                        |

### Context overflow

When incoming data (RAG results, MCP responses) still exceeds the context budget after compaction, the original content is written to a temporary overflow path and a reference summary is injected into the prompt in its place:

```
{company_slug}/tasks/{agent_id}/context-overflow/{timestamp}.txt
```

If the write fails, the compacted (truncated) version is used instead. See [Context Management](context-management.md) for the full compaction strategy.

## Managing knowledge documents

Role knowledge documents are uploaded via lcp-cli and stored under `knowledge/{role_name}/`. The server chunks, embeds, and indexes them for RAG retrieval automatically on upload.

```bash
# Upload documents
./lcp-cli.sh store-role-documents -r <roleId> -s policy.md handbook.md

# List stored documents
./lcp-cli.sh list-role-documents -r <roleId>

# Remove documents by pattern
./lcp-cli.sh remove-role-documents -r <roleId> -p "*.md"
```

See [`lcp-cli.md` → document management verbs](lcp-cli.md#store-role-documents) and [Agent Services → RAG](agent-services.md#rag-retrieval-augmented-generation) for full details.

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
