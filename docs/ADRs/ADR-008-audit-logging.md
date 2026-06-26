# ADR-008: Audit Logging

Status: Partially Implemented

## Context

Every agent action — every LLM message sent and received, every tool call and its result, every state change — must be recorded. This serves:

- Debugging and inspection of agent behaviour
- Compliance and accountability
- Training data for future model improvements
- User observation of in-progress tasks (see [ADR-012](./ADR-012-human-in-the-loop.md))

Two distinct capture paths are needed:

1. **Automatic capture** — the software records all LLM/tool activity unconditionally; no agent action required
2. **Agent-initiated decision logging** — agents can explicitly log a _decision with justification_ (e.g., "chose REST over GraphQL because the client requires simple key-value lookups") via an MCP tool

## Storage options

| Option                              | Queryable | Human-readable | Real-time   | Notes                                             |
| ----------------------------------- | --------- | -------------- | ----------- | ------------------------------------------------- |
| **DB table only**                   | ✓         | partial        | ✓           | Fast inserts; easy queries; hard to grep raw text |
| **Files in shared storage only**    | ✗         | ✓              | delayed     | Easy to inspect; no structured query              |
| **Hybrid (DB + export to storage)** | ✓         | ✓              | ✓ + delayed | Best of both; slightly more moving parts          |

## Decision

**Hybrid**: PostgreSQL `audit_events` table (automatic, real-time) + exported JSON Lines files in MinIO (archival, human-readable).

### Automatic capture

LangGraph emits a structured event stream during graph execution (see [ADR-002](./ADR-002-agent-loop-framework.md)). lcp-agent subscribes to this stream and writes each event to the `audit_events` table. No agent code changes are required — every LLM call, tool invocation, and state transition is captured automatically.

### Agent MCP audit server

A standard MCP tool exposed to all agents:

| Tool                                             | Description                                            |
| ------------------------------------------------ | ------------------------------------------------------ |
| `log_decision(summary, justification, context?)` | Agent explicitly records a decision with its reasoning |

This writes a row to `audit_events` with `event_type = 'decision'`. It encourages agents to narrate their reasoning, producing a richer semantic audit trail alongside the raw LLM transcript.

### `audit_events` table schema

| Column       | Type        | Notes                                                                                 |
| ------------ | ----------- | ------------------------------------------------------------------------------------- |
| `id`         | UUID        | Primary key                                                                           |
| `timestamp`  | TIMESTAMPTZ | Event time                                                                            |
| `company_id` | UUID        | FK to company                                                                         |
| `role`       | VARCHAR     | Role name (e.g., `software-architect`)                                                |
| `task_id`    | UUID        | FK to task                                                                            |
| `step_id`    | UUID        | FK to task step                                                                       |
| `event_type` | VARCHAR     | `llm_request`, `llm_response`, `tool_call`, `tool_result`, `decision`, `state_change` |
| `payload`    | JSONB       | Full event content                                                                    |

Primary index: `(company_id, task_id, timestamp)` — covers the common "show me everything for this task" query.

### Export to shared storage

At the end of each task step, lcp-agent writes the step's audit events to MinIO as a JSON Lines file at `audit/{task_id}/{step_id}.jsonl` (see [ADR-007](./ADR-007-shared-company-storage.md)). This provides a durable, human-inspectable archive without querying the database.

### Retention

- Configurable per company; indefinite by default
- Retention policy applied by a scheduled cleanup job (future)
- MinIO object versioning means exported files are retained even if accidentally overwritten

## Implementation status

### What changed from the original plan

The original plan described a hybrid approach (DB writes + MinIO export). The implementation diverges in two ways:

**1. HTTP audit endpoint instead of direct DB writes from MCP servers**

lcp-mcp-storage, lcp-mcp-memory, and lcp-mcp-interactions do not have database connections for audit purposes. Instead, each calls `POST /internal/audit` on lcp-server (protected by `X-Internal-Api-Key`). lcp-server's `AuditService` handles the actual write. lcp-agent also uses this endpoint (via `AuditClientService`) rather than writing directly.

This gives a single audit write path. Calls are fire-and-forget (errors are logged but never propagate to the agent).

**2. `complete_task` replaces `log_decision`**

The `log_decision` MCP tool described in this ADR was not implemented. Instead, agents call `complete_task` (on lcp-mcp-interactions) as their mandatory final action. This writes a `state_change` audit event and stores the agent's final answer, which provides the semantic closure `log_decision` intended.

### Implemented

- `audit_event` table with `(company_id, role, agent_id, event_type, payload)` columns
- `POST /internal/audit` endpoint on lcp-server (protected by `InternalApiKeyGuard`)
- `AuditClientService` in lcp-agent — HTTP client to the internal endpoint; fire-and-forget
- `AuditService` in lcp-server — writes `AuditEvent` rows
- All three MCP servers write `tool_call` and `tool_result` events for each tool invocation
- lcp-agent writes `llm_request`, `llm_response`, `tool_call`, `tool_result`, `state_change`, and `decision` events from the LangGraph event stream
- `complete_task` writes a `state_change` event with the agent's final answer

### Deferred

- MinIO JSONL export (archival path) — export events to `audit/{id}/` as JSON Lines files
- Audit log query/filter API
- Retention policy and scheduled cleanup

## Consequences

- lcp-agent subscribes to LangGraph's event stream and maps each event type to a row in `audit_events` via `POST /internal/audit`
- All MCP servers have `AuditClientService` injected; audit writes are fire-and-forget and never block tool responses
- User-facing "live audit" stream is served from the `audit_events` table via SSE (see [ADR-012](./ADR-012-human-in-the-loop.md))

## Open Questions / Assumptions

- JSONB payload size: very long LLM responses could be large. Consider truncating/summarising payloads above a threshold, or storing large payloads as MinIO objects referenced by the row.
- Agents call `complete_task` as their last action; the completion enforcement logic in lcp-agent ensures this happens even if the agent forgets.
