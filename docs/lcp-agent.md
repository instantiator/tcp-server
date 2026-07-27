# lcp-agent

The `lcp-agent` service runs the LangGraph agent loop. It consumes jobs from the `agent-jobs` BullMQ queue and executes or resumes an agent run for each job.

---

## How it works

1. **lcp-server** creates an `LcpAgent` record and enqueues a job: `{ agentId, type: 'start' | 'resume' }`.
2. **lcp-agent's** `AgentWorkerService` picks up the job and calls `AgentLoopService.run(agentId)`.
3. `AgentLoopService`:
   - Loads the `LcpAgent` and its `LcpRole` from the shared PostgreSQL database.
   - Sets the agent status to `running`.
   - Opens a `PostgresSaver` checkpoint store (LangGraph resumability).
   - Builds a `StateGraph` with a single `agent` node that invokes the configured LLM.
   - Streams graph events; writes an `AuditEvent` row for each LLM request/response.
   - After the stream: validates that the agent produced non-empty output; retries once if not.
   - Sets the final status to `completed` or `failed`.
   - Cleans up: closes the checkpoint pool, deregisters the agent from the in-memory registry.

---

## Authentication

All `lcp-server` API endpoints (`/api/*`) require a Bearer token from your OIDC provider. Obtain one from Zitadel via `lcp-cli get-token` (device-flow login; see [zitadel-setup.md](zitadel-setup.md)) and pass it in every request:

```
-H "Authorization: Bearer <token>"
```

The `/health` endpoints on both services are public and do not require a token.

---

## Company-level LLM default

A company can carry a `llmConfig` — a fallback `LlmConfig` used by any role that does not supply its own. This avoids repeating provider and model details on every role when all roles in a company share the same LLM.

```bash
curl -X POST http://localhost:3000/api/company \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "acme",
    "name": "Acme Corp",
    "llmConfig": {
      "provider": "lm-studio",
      "model": "qwen3-5b",
      "baseUrl": "http://localhost:1234/v1",
      "apiKey": "your-lm-studio-token"
    }
  }'
```

**Fallback rules** (see `LlmConfigResolver` in `@lcp/shared`):

1. If the role has its own `llmConfig`, that is used.
2. Otherwise the company's `llmConfig` is used.
3. Otherwise the server/agent environment's `LLM_PROVIDER`/`LLM_MODEL` fallback is used.
4. If none of the three is set, the agent run fails immediately with status `failed`.

A role with no `llmConfig` and a company with no `llmConfig` are both accepted at create/update time — the environment fallback (or a failed run, if that's also unset) covers it at run time. Nothing is rejected up front.

---

## Creating a role

`llmConfig` is optional when the company has a `llmConfig`, or when the server/agent environment has an `LLM_PROVIDER`/`LLM_MODEL` fallback configured.

```bash
curl -X POST http://localhost:3000/api/role \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "companyId": "<uuid>",
    "name": "Analyst",
    "description": "Analyses market data and produces structured reports.",
    "llmConfig": {
      "provider": "lm-studio",
      "model": "qwen3-5b",
      "baseUrl": "http://localhost:1234/v1",
      "apiKey": "your-lm-studio-token"
    },
    "systemPromptTemplate": "You are {{name}}, a specialist at {{description}}. It is {{datetime}} — you are in region {{timezone}}, where the local time is {{localDatetime}}."
  }'
```

`apiKey` holds the API key for the provider. It is stored in the database as part of the JSONB config block and masked (`***`) in API responses by default. Set `LCP_MASK_API_KEYS=false` in the environment to expose raw keys during local debugging.

`systemPromptTemplate` is optional — a blank or omitted value resolves via `SystemPromptTemplateResolver`: the role's own template, then the company's, then a baked-in default (`DEFAULT_SYSTEM_PROMPT_TEMPLATE`).

### Template placeholders

| Placeholder         | Value                                                                         |
| ------------------- | ----------------------------------------------------------------------------- |
| `{{name}}`          | `LcpRole.name`                                                                |
| `{{description}}`   | `LcpRole.description`                                                         |
| `{{date}}`          | Current UTC date, `YYYY-MM-DD` (kept for older templates)                     |
| `{{datetime}}`      | Current UTC date and time, explicitly labeled — the LLM's authoritative "now" |
| `{{timezone}}`      | The company's IANA timezone name, or `UTC` when unset                         |
| `{{localDatetime}}` | `{{datetime}}` localized to `{{timezone}}`; equals `{{datetime}}` when unset  |
| `{{companyId}}`     | `LcpAgent.companyId` — for tool calls that require it                         |
| `{{roleId}}`        | `LcpRole.id` — for tool calls that require it                                 |

---

## Starting an agent

```bash
curl -X POST http://localhost:3000/api/agent/start \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "companyId": "<uuid>",
    "roleId": "<uuid>",
    "initialPrompt": "Summarise the current state of the renewable energy market."
  }'
```

Returns the `LcpAgent` record. Poll `GET /api/agent/:id` to track status.

---

## Resuming an agent

```bash
curl -X POST http://localhost:3000/api/agent/resume/:id \
  -H "Authorization: Bearer <token>"
```

Valid from status `idle`, `paused`, or `failed`. Re-enqueues the agent; the LangGraph checkpoint store restores prior conversation state.

---

## Checking model compatibility

Before assigning a role to a model, verify that the model supports the required capabilities:

```bash
curl -X POST http://localhost:3000/api/model/check \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "models": [
      {
        "provider": "lm-studio",
        "model": "qwen3-5b",
        "baseUrl": "http://localhost:1234/v1",
        "apiKey": "your-lm-studio-token"
      }
    ]
  }'
```

Returns `{ provider, model, supportsTools, supportsStructuredOutput, compatible, error? }` for each model. `compatible` is `true` if both tool-calling and structured output are confirmed.

---

## Resource limits (MVP)

| Limit         | Value | Config                           |
| ------------- | ----- | -------------------------------- |
| Max LLM calls | 10    | Hard-coded in `AgentLoopService` |
| Timeout       | 60 s  | Hard-coded in `AgentLoopService` |

Both are candidates for `LcpRole.runConfig` JSONB once per-role tuning is needed.

To estimate a role's worst-case initial-prompt token footprint against its
LLM's context window before running it, see `lcp-cli`'s
[`estimate-context-window`](lcp-cli.md#estimate-context-window) — it reuses
the same `ContextBudgetService` used at runtime to decide when to compact context.

---

## MCP tools

Before running the LangGraph loop, `AgentLoopService` connects to each MCP server listed in `role.mcpServerList` and loads its tools. Tools are exposed to the model as `{serverName}__{toolName}` (e.g. `storage__list_files`) to prevent collisions across servers. If a server is unreachable, it is silently skipped and the agent runs with whatever tools did load.

MCP server URLs are resolved from environment variables:

| Variable               | Server                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `MCP_STORAGE_URL`      | [lcp-mcp-storage](lcp-mcp-storage.md) — MinIO file operations                              |
| `MCP_MEMORY_URL`       | [lcp-mcp-memory](lcp-mcp-memory.md) — episodic memory and knowledge search (stub)          |
| `MCP_INTERACTIONS_URL` | [lcp-mcp-interactions](lcp-mcp-interactions.md) — user input and agent consultation (stub) |

See [agent-services.md → MCP Servers](agent-services.md#mcp-servers) for configuration details.

---

## In-loop tracking

While the agent loop runs, `AgentLoopService` maintains an in-memory tracker that accumulates two things:

**Action log** — a human-readable ordered list of tool invocations, e.g. `"Wrote file: docs/report.md"`, `"Requested user input: What is the budget?"`. Populated on every `on_tool_start` event, including failed tool calls.

**Storage changes** — structured record of MinIO mutations: `created`, `modified`, `deleted`, and `moved` file paths. Populated on `on_tool_end` events by inspecting the tool result text (e.g. `"Written:"`, `"Deleted:"`, `"Moved:"`).

After each storage `on_tool_end`, the tracker is persisted to `LcpAgent.storageChanges` via a fire-and-forget `PATCH /internal/agent/:id/storage` to lcp-server. This makes the data available to lcp-mcp-interactions for `complete_task` file validation error messages without in-process coupling.

---

## Audit events

Every agent run produces `AuditEvent` rows in the `audit_event` table:

| Event type              | When                                                                  |
| ----------------------- | --------------------------------------------------------------------- |
| `llm_request`           | LLM invocation starts                                                 |
| `llm_response`          | LLM invocation completes                                              |
| `tool_call`             | MCP tool is invoked                                                   |
| `tool_result`           | MCP tool returns a result                                             |
| `state_change`          | Agent status changes (e.g. failed with reason)                        |
| `agent_loop_completion` | Agent loop ends via `complete_task` — structured summary + action log |

The `agent_loop_completion` payload is an `AgentLoopCompletionSummary`:

```json
{
  "summary": "The agent analysed the renewable energy market and produced report.md.",
  "actions": [
    "Read file: context/brief.md",
    "Wrote file: docs/report.md",
    "Submitted task completion"
  ],
  "storage": {
    "created": ["docs/report.md"],
    "modified": [],
    "deleted": [],
    "moved": []
  }
}
```

The `summary` field is generated by a direct LLM call after the run completes. If the LLM call fails, the event is not written (the failure is logged as a warning; the task status is unaffected).

Query: `SELECT * FROM audit_event WHERE agent_id = $1 ORDER BY timestamp`.

---

## Health check

`GET http://localhost:3001/health` — checks PostgreSQL connectivity and Redis connectivity. Returns HTTP 200 when both are up, 503 when either is down.

The Redis check uses the shared bounded `assertRedisReachable` probe, so it cannot hang. lcp-agent also fails fast at **startup** if Redis is unreachable (`AgentWorkerService.onModuleInit`): rather than letting the BullMQ worker block indefinitely against a downed broker, it throws a clear error. `main.ts` calls `app.enableShutdownHooks()` so the worker and its Redis connection close cleanly on `SIGTERM`.

> **Known gap (non-blocking):** `config/config.schema.ts` still requires `MINIO_ENDPOINT`/`MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` at startup, but lcp-agent never constructs an S3 client anywhere — storage access across the whole monorepo goes through `lcp-server`'s `StorageService`/`/internal/storage/*` endpoints instead. Likely leftover from an earlier design. Not removed in this pass; flagged here as a follow-up cleanup opportunity.
