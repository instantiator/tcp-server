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

LangGraph emits a structured event stream during graph execution (see [ADR-002](./ADR-002-agent-loop-framework.md)). tcp-agent subscribes to this stream and writes each event to the `audit_events` table. No agent code changes are required — every LLM call, tool invocation, and state transition is captured automatically.

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

At the end of each task step, tcp-agent writes the step's audit events to MinIO as a JSON Lines file at `audit/{task_id}/{step_id}.jsonl` (see [ADR-007](./ADR-007-shared-company-storage.md)). This provides a durable, human-inspectable archive without querying the database.

### Retention

- Configurable per company; indefinite by default
- Retention policy applied by a scheduled cleanup job (future)
- MinIO object versioning means exported files are retained even if accidentally overwritten

## Implementation status

### What changed from the original plan

The original plan described a hybrid approach (DB writes + MinIO export). The implementation diverges in two ways:

**1. HTTP audit endpoint instead of direct DB writes from MCP servers**

tcp-mcp-storage, tcp-mcp-memory, and tcp-mcp-interactions do not have database connections for audit purposes. Instead, each calls `POST /internal/audit` on tcp-server (protected by `X-Internal-Api-Key`). tcp-server's `AuditService` handles the actual write. tcp-agent also uses this endpoint (via `AuditClientService`) rather than writing directly.

This gives a single audit write path. Calls are fire-and-forget (errors are logged but never propagate to the agent).

**2. `complete_task` replaces `log_decision`**

The `log_decision` MCP tool described in this ADR was not implemented. Instead, agents call `complete_task` (on tcp-mcp-interactions) as their mandatory final action. This writes a `state_change` audit event and stores the agent's final answer, which provides the semantic closure `log_decision` intended.

### Implemented

- `audit_event` table with `(company_id, role, agent_id, event_type, payload)` columns
- `POST /internal/audit` endpoint on tcp-server (protected by `InternalApiKeyGuard`)
- `AuditClientService` in tcp-agent — HTTP client to the internal endpoint; fire-and-forget
- `AuditService` in tcp-server — writes `AuditEvent` rows
- All three MCP servers write `tool_call` and `tool_result` events for each tool invocation
- tcp-agent writes `llm_request`, `llm_response`, `tool_call`, `tool_result`, `state_change`, and `decision` events from the LangGraph event stream
- `complete_task` writes a `state_change` event with the agent's final answer
- Storage-tool audit events (`write_file`, `delete_file`, `restore_file`, `copy_file`, `move_file`, and the knowledge-file equivalents) nest an `originators: { user, agent, task }` object inside `payload`, tracking who requested the action — `user` for direct JWT-authenticated calls (`POST /api/storage`, knowledge uploads via the CLI/API directly), `agent` for MCP-tool-initiated calls (added to those tools' schemas so `McpClientService`'s `fixedArgs` mechanism injects the real value), `task` reserved for a future task concept (always `null` today). No schema change — `payload` is already `jsonb`.

<a id="amendments-as-implemented-0094"></a>

> **Note (009.4):** `apps/tcp-mcp-storage`'s storage-tool audit calls previously always passed a nil-UUID placeholder (`00000000-0000-0000-0000-000000000000`) as `companyId`, since no real company context was threaded through. This silently failed on every call: `AuditEvent.company` is a real FK (`nullable: false`) and no company with that id exists, so `POST /internal/audit` 500'd every time — invisible because `AuditClientService.record()` is fire-and-forget (errors logged, never thrown). No storage-tool audit trail existed in the database despite the code appearing to write one. Fixed by resolving a real `companyId` from the object key's leading slug segment (`MinioStorageAdapter.emitStorageAudit`), and skipping the write (with a visible `logger.warn`) rather than repeating the placeholder when no matching company can be found. The audit write itself is also now wrapped so it can never turn a successful storage operation into a 500 for the caller — an audit-side failure (e.g. a stale `agentId` no longer present in `tcp_agent`) is logged and swallowed, matching the same fire-and-forget guarantee `AuditClientService` already gives HTTP callers.

<a id="amendments-as-implemented-0086"></a>

> **Note (008.6):** `POST /internal/audit` was silently failing every real call with a `500` — `CreateAuditEventDto` had no `class-validator` decorators on any field, so the app-wide `ValidationPipe({ whitelist: true })` (see `AppModule`) stripped the entire body before validation, leaving `companyId`/`role`/`eventType`/`payload` all `undefined` and failing the entity's `NOT NULL` constraints. Fire-and-forget error handling meant this had no visible effect on agents or tools — only the audit log itself was silently empty. Found and fixed during 008.6's manual verification pass (not part of that plan's original scope): every `CreateAuditEventDto` field now has a decorator (`@IsUUID`, `@IsString`, `@IsIn`, `@IsObject`), with a regression test (`create-audit-event.dto.spec.ts`) driving the real `ValidationPipe` directly, plus e2e coverage (`audit.e2e-spec.ts`) exercising the actual HTTP endpoint end-to-end — the previous e2e suite only tested `AuditService.record()` in-process and the 401-unauthenticated case, never a valid authenticated request through the real endpoint, which is why this went undetected.

<a id="amendments-as-implemented-01031"></a>

> **Note (010.3.1):** The audit log query/filter API (listed as Deferred below) is now partially implemented — read-only, JWT-guarded endpoints for reconstructing an agent's or a task's history: `GET /api/agent/:id/history` and `GET /api/task/:id/history` (`AuditService.list`, ordered oldest-first, optionally scoped to a set of agent ids). These back the `tcp-cli eavesdrop --show-history` verb. No general-purpose filter API (by event type, date range, free-text) exists yet — only "every event for this agent" or "every event for this task's own assignments' agents".

<a id="amendments-as-implemented-01032"></a>

> **Note (010.3.2):** `audit_event` gained a denormalized `assignmentId` column (nullable, `varchar` to match `agentId`'s cross-DB-compatible type; composite index `(companyId, assignmentId, timestamp)` alongside the existing `(companyId, agentId, timestamp)`). `AuditService.write` derives it from the writing agent's current `assignmentId` (a lookup by `agentId`, not a caller-supplied field — this can never drift from `tcp_agent`, the source of truth) rather than threading a new parameter through every `AuditClientService.record()` call site across tcp-agent and the MCP servers. `taskId` was deliberately **not** added to `AuditEvent`: with [ADR-010](./ADR-010-orchestration-design.md)'s `TcpAssignment.parentAssignmentId`/inherited `taskId` landing in the same change, "audit rows for task X" is one indexed join away (`assignment.taskId = X → assignmentId IN (…)`, see `AuditService.listByAssignments`) — a second copy of the same data wasn't worth the write-path complexity. This also closes the consultation-tracing gap noted above: since a consultation assignment now inherits its `taskId` from the assignment that spawned it, `TaskService.getHistory`'s existing "gather this task's assignments' agents" query includes consultations automatically, with no parent-chain walk.

<a id="amendments-as-implemented-01051"></a>

> **Note (010.5.1):** Audit events are now the **single source of truth for both history and live streaming**, replacing the parallel live-event unions that previously mirrored the audit log. Three changes:
>
> - **`taskId` column added** (reversing 010.3.2's "deliberately not added" — the drift-free denormalization won out once the CLI needed to filter task history without an assignments→agents join): nullable `varchar`, composite index `(companyId, taskId, timestamp)`, derived server-side in `AuditService.write` from the writing agent's assignment (or supplied explicitly for agent-less orchestrator rows). `TaskService.getHistory` is now a single `AuditService.listByTask` query — which also fixes a gap: agent-less orchestrator rows (`agentId` null) that the old assignments→agents join missed now appear in task history.
> - **Two new event types**: `compaction` (`{ phase: 'started' | 'complete', … }`, replacing the old `decision`-with-`event:compaction_*` rows and the separate SSE emit) and `input` (user-submitted text — chat messages and conversation answers — `{ text }`). `state_change` payloads now carry a mandatory `entity` discriminator (`agent` | `assignment` | `task` | `company`) that drives SSE channel routing and rendering.
> - **Persist-then-publish**: `AuditService.write` saves the row, then hands it to `AuditEventPublisher`, which emits it (as a `WireEvent`) on the relevant agent/task/company SSE channel. This replaced the former `AgentEventService` + per-producer `events.emit(...)` + `audit.record(...)` dual-write, so the live stream and history can never drift. Only token `StreamDelta`s (reasoning/response, live-only) stay off the audit table — the turn's full text persists in the `llm_response` row's `responseText`.

### Deferred

- MinIO JSONL export (archival path) — export events to `audit/{id}/` as JSON Lines files
- General-purpose audit log query/filter API (by event type, date range, free-text search) — see the 010.3.1 note above for what exists today
- Retention policy and scheduled cleanup

## Consequences

- tcp-agent subscribes to LangGraph's event stream and maps each event type to a row in `audit_events` via `POST /internal/audit`
- All MCP servers have `AuditClientService` injected; audit writes are fire-and-forget and never block tool responses
- User-facing "live audit" stream is served from the `audit_events` table via SSE (see [ADR-012](./ADR-012-human-in-the-loop.md))

## Open Questions / Assumptions

- JSONB payload size: very long LLM responses could be large. Consider truncating/summarising payloads above a threshold, or storing large payloads as MinIO objects referenced by the row.
- Agents call `complete_task` as their last action; the completion enforcement logic in tcp-agent ensures this happens even if the agent forgets.
- **(009.4)** There is no mechanism today to trace an MCP-tool-initiated action back to the human who ultimately requested the work. `McpToolContext` (see [ADR-013](./ADR-013-prompt-assembly-context-management.md)) carries `agentId`/`companyId` only; no `task` concept exists yet to carry a requesting-user reference through the agent→task→tool-call chain, so `originators.user` stays `null` for every agent-initiated storage action (see the `originators` amendment above). [ADR-010](./ADR-010-orchestration-design.md) (orchestration design) is the ADR that will need to introduce that chain — likely a `task` entity owning both the requesting user and the agents/consultations spawned under it — before `originators.user` can ever be populated for agent-initiated actions. Recorded here so this gap surfaces again in whatever future pass tackles task modeling, rather than being rediscovered from scratch.

## Amendment as implemented (001.01, phase 04) <a id="amendment-as-implemented-p04-001-01"></a>

[001.01](../prompts/phase%2004%20-%20utility/001.01.01.plan%20-%20records%20mcp%20server%20for%20structured%20records.md) added `tcp-mcp-records`. The decisions above stand. This amendment records what the records server writes, and corrects a sentence in the Implemented list.

**Which servers write audit events.** The Implemented list says all three MCP servers write `tool_call` and `tool_result` events. That is no longer true. `tcp-agent` records a `tool_call` and a `tool_result` for every MCP tool call, so every server is covered that way. On top of that, `tcp-mcp-storage`, `tcp-mcp-tasks` and `tcp-mcp-records` write events of their own, because they know what changed. `tcp-mcp-utilities` writes none, since it changes nothing.

**What the records server writes.** Through `AuditClientService`, fire-and-forget, with role `agent` and the calling `agentId`. tcp-server fills in the task and assignment from the agent, as it does for every row. Every payload carries `source: 'records'`.

A change is a `state_change`:

| `action`       | Payload besides `source` and `action`               |
| -------------- | --------------------------------------------------- |
| `create_table` | `table`, `definition` (name, purpose, schema, keys) |
| `insert`       | `table`, `recordId`, `before: null`, `after`        |
| `update`       | `table`, `recordId`, `before`, `after`              |
| `delete`       | `table`, `recordId`, `before`, `after: null`        |

A read is a `tool_call`:

| `tool`      | Payload besides `source` and `tool`                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| `query`     | `table`, `filters`, `recordIds` (the ids returned)                                                                |
| `aggregate` | `table`, `op`, `field`, `groupBy`, `filters`, `groups` (how many groups came back)                                |
| `insert`    | `table`, `outcome: 'already_exists'`, `recordIds`. An insert that wrote nothing but read back the existing record |

A call that fails validation changes and reads nothing, so it writes no event.

**Consequences.**

- The before and after values of a record are in the audit log. A deleted record's last values survive there.
- Because the write is fire-and-forget, a lost audit request does not roll back the change. The record and its history can disagree. This is recorded in [outstanding-issues.md](../outstanding-issues.md#records-audit-is-fire-and-forget).
- The records server may use a database that holds no `tcp_role`, so it sends the fixed role `agent`, as `tcp-mcp-tasks` does.

See [tcp-mcp-records.md](../tcp-mcp-records.md#audit).

## Amendment as implemented (001.03, phase 04) <a id="amendment-as-implemented-p04-001-03"></a>

[001.03](../prompts/phase%2004%20-%20utility/001.03.01.plan%20-%20records%20view%2C%20edit%20and%20csv%20export%20in%20the%20web%20ui.md) lets people change records in the web UI. The decisions above stand. This amendment records the first audit events that tcp-server writes for a person's action on a company's data.

**Who writes them.** tcp-server itself (`RecordsApiService`), through `AuditService`, not over HTTP. The role is `user` and there is no agent. Every payload carries `source: 'records'` and `userId`, the JWT `sub` of the person who acted. This is the first controller to audit as a user.

A change is a `state_change`:

| `action`       | Payload besides `source`, `action` and `userId` |
| -------------- | ----------------------------------------------- |
| `create_table` | `table`, `definition`                           |
| `add_row`      | `table`, `recordId`, `after`                    |
| `update`       | `table`, `recordId`, `before`, `after`          |
| `delete_row`   | `table`, `recordId`, `before`                   |
| `append_csv`   | `table`, `inserted`, `alreadyExists`            |
| `clear_table`  | `table`, `removed` (a count)                    |
| `drop_table`   | `table`, `definition`, `removed` (a count)      |

Clear and drop record how many rows went, not the rows themselves. Drop keeps the table's definition, so the table can be made again. A person's reads are not audited, in line with the storage proxy.

**Consequences.**

- A person's correction of an agent's record can be told apart from the agent's own write by its role.
- Clear and drop leave no copy of the removed rows, only the count. A person who wants a copy can download one first, and the web UI offers it.
- Any company member can do all of this. Limiting clear and delete to owners waits for membership role flags (see [outstanding-issues.md](../outstanding-issues.md#clear-and-delete-are-open-to-every-company-member)).

## Amendment as implemented (001.04, phase 04) <a id="amendment-as-implemented-p04-001-04"></a>

Data protection ([ADR-036](ADR-036-customer-data-protection.md)) added `state_change` events with `source: records`: `delete_rows`, `set_retention`, `retention_sweep` (role `system`), and `do_not_store_add`/`_update`/`_remove`. They carry ids, counts, table and field names, **never row values or list entries**, because the audit log outlives an erasure. A refused agent write is a `tool_call` with `outcome: do_not_store` and the field names. A person storing data despite the list adds `doNotStoreOverride: [fields]`. A system halt is a `state_change` with `entity: system`.

## Amendment as implemented (001.05, phase 04) <a id="amendment-as-implemented-p04-001-05"></a>

[001.05](../prompts/phase%2004%20-%20utility/001.05.01.plan%20-%20live%20record%20updates.md) lets records audits feed the web UI. Every `state_change` with `source: 'records'`, from agents, people and the retention sweep alike, now also reaches the company stream. It goes as `{entity: 'record', action, table}` only. The persisted row, and what the agent stream carries, are unchanged. See [ADR-025](ADR-025-browser-event-stream-consumption.md#amendment-as-implemented-p04-001-05).

## Amendment as implemented (001.06, phase 04) <a id="amendment-as-implemented-p04-001-06"></a>

[001.06](../prompts/phase%2004%20-%20utility/001.06.01.plan%20-%20record%20table%20schema%20changes.md) lets agents and people change a table's columns and primary key. A change is one more `state_change` with `source: 'records'`:

| `action`      | Payload besides `source` and `action`                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `alter_table` | `op` (`add_column`, `rename_column`, `delete_column`, `set_primary_key`), `table`, `before` and `after` definitions, `rewritten` (a count) |

It is written by tcp-mcp-records as role `agent`, and by tcp-server as role `user` with `userId` and, for a confirmed do-not-store match, `doNotStoreOverride`. **A new column's default value is never in the payload**, in line with 001.04: it is row data, and the audit log outlives an erasure. The definitions are kept, so a deleted column can be made again, though its values are gone; the web UI offers a download first. An agent's request to delete a column changes nothing and writes no `state_change`: tcp-agent's own `tool_call` and `tool_result` record it. Like every records change, it reaches the company stream cut down to `{entity: 'record', action, table}`.
