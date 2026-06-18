# ADR-007: Shared Company Storage

Status: Proposed

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

| Option | Versioning | Per-company isolation | Self-hosted | Notes |
|--------|-----------|----------------------|-------------|-------|
| **Filesystem + MCP filesystem server** | ✗ | By directory convention | ✓ | Simplest; adequate for a single-host deployment; no formal access control or versioning |
| **MinIO (S3-compatible, Docker)** | ✓ (bucket versioning) | ✓ (one bucket per company) | ✓ | S3-compatible; per-company bucket = natural isolation; versioning built-in; S3 MCP server available |
| **PostgreSQL large objects** | ✓ (via DB history) | ✓ (by query) | ✓ | No extra service; not designed for large file storage; poor ergonomics for file-like access |
| **Cloud object storage (S3, GCS)** | ✓ | ✓ (bucket policies) | ✗ | Best for production scale; requires cloud credentials; not self-hostable |

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
  audit/
    {task_id}/
      {step_id}.jsonl    ← exported audit log per task step (see ADR-008)
```

### Storage MCP server

Agents access company storage via a **storage MCP server** (S3-compatible). Tools:

| Tool | Description |
|------|-------------|
| `read_file(path)` | Read a file from the company bucket |
| `write_file(path, content)` | Write or overwrite a file |
| `list_files(prefix?)` | List files under a path prefix |
| `delete_file(path)` | Delete a file (creates a delete marker; recoverable via versioning) |

The storage MCP server is scoped to the company bucket at startup — it cannot access other companies' buckets.

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
