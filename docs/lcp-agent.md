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

All `lcp-server` API endpoints (`/api/*`) require a Bearer token from your OIDC provider. Obtain one from Keycloak (see [keycloak-setup.md](keycloak-setup.md)) and pass it in every request:

```
-H "Authorization: Bearer <token>"
```

The `/health` endpoints on both services are public and do not require a token.

---

## Company-level LLM default

A company can carry a `llmDefault` — a fallback `LlmConfig` used by any role that does not supply its own. This avoids repeating provider and model details on every role when all roles in a company share the same LLM.

```bash
curl -X POST http://localhost:3000/api/company \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "acme",
    "name": "Acme Corp",
    "llmDefault": {
      "provider": "lm-studio",
      "model": "qwen3-5b",
      "baseUrl": "http://localhost:1234/v1",
      "apiKey": "your-lm-studio-token"
    }
  }'
```

**Fallback rules:**

1. If the role has its own `llmConfig`, that is used.
2. Otherwise the company's `llmDefault` is used.
3. If neither is set, the agent run fails immediately with status `failed`.

**Guard:** The API rejects:

- Creating a role with no `llmConfig` when the company has no `llmDefault` (HTTP 400)
- Updating a company to remove `llmDefault` when any of its roles have no `llmConfig` (HTTP 400)

---

## Creating a role

`llmConfig` is optional when the company has a `llmDefault`.

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
    "systemPromptTemplate": "You are {{name}}, a specialist at {{description}}. Today is {{date}}."
  }'
```

`apiKey` holds the API key for the provider. It is stored in the database as part of the JSONB config block and masked (`***`) in API responses by default. Set `LCP_MASK_API_KEYS=false` in the environment to expose raw keys during local debugging.

### Template placeholders

| Placeholder       | Value                                     |
| ----------------- | ----------------------------------------- |
| `{{name}}`        | `LcpRole.name`                            |
| `{{description}}` | `LcpRole.description`                     |
| `{{date}}`        | Current date (ISO format, date part only) |

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

Both are candidates for `LcpRole.runConfig` JSONB once per-role tuning is needed (see `docs/prompts/003.3`).

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
