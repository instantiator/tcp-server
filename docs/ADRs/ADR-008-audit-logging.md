# ADR-008: Audit Logging

Status: Proposed

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

## Consequences

- lcp-agent subscribes to LangGraph's event stream and maps each event type to a row in `audit_events`
- The audit MCP server is part of the standard LCP MCP suite; it is always available to agents
- User-facing "live audit" stream is served from the `audit_events` table via SSE (see [ADR-012](./ADR-012-human-in-the-loop.md))

## Open Questions / Assumptions

- JSONB payload size: very long LLM responses could be large. Consider truncating/summarising payloads above a threshold, or storing large payloads as MinIO objects referenced by the row.
- The `log_decision` MCP tool is a suggestion, not an enforcement. Agents are not required to call it — all activity is captured automatically regardless.
