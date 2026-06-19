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

## Creating a role

```bash
curl -X POST http://localhost:3000/api/role \
  -H "Content-Type: application/json" \
  -d '{
    "companyId": "<uuid>",
    "name": "Analyst",
    "description": "Analyses market data and produces structured reports.",
    "llmConfig": {
      "provider": "lm-studio",
      "model": "qwen3-5b",
      "baseUrl": "http://localhost:1234/v1",
      "apiKeyEnvVar": "LM_STUDIO_API_KEY"
    },
    "systemPromptTemplate": "You are {{name}}, a specialist at {{description}}. Today is {{date}}."
  }'
```

`apiKeyEnvVar` names an environment variable that holds the API key. The key itself is never stored in the database.

### Template placeholders

| Placeholder | Value |
|---|---|
| `{{name}}` | `LcpRole.name` |
| `{{description}}` | `LcpRole.description` |
| `{{date}}` | Current date (ISO format, date part only) |

---

## Starting an agent

```bash
curl -X POST http://localhost:3000/api/agent/start \
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
curl -X POST http://localhost:3000/api/agent/resume/:id
```

Valid from status `idle`, `paused`, or `failed`. Re-enqueues the agent; the LangGraph checkpoint store restores prior conversation state.

---

## Checking model compatibility

Before assigning a role to a model, verify that the model supports the required capabilities:

```bash
curl -X POST http://localhost:3000/api/model/check \
  -H "Content-Type: application/json" \
  -d '{
    "models": [
      {
        "provider": "lm-studio",
        "model": "qwen3-5b",
        "baseUrl": "http://localhost:1234/v1",
        "apiKeyEnvVar": "LM_STUDIO_API_KEY"
      }
    ]
  }'
```

Returns `{ provider, model, supportsTools, supportsStructuredOutput, compatible, error? }` for each model. `compatible` is `true` if both tool-calling and structured output are confirmed.

---

## Resource limits (MVP)

| Limit | Value | Config |
|---|---|---|
| Max iterations | 10 | Hard-coded in `AgentLoopService` |
| Timeout | 60 s | Hard-coded in `AgentLoopService` |

Both are candidates for `LcpRole.runConfig` JSONB once per-role tuning is needed (see `docs/prompts/003.3`).

---

## Audit events

Every agent run produces `AuditEvent` rows in the `audit_event` table:

| Event type | When |
|---|---|
| `llm_request` | LLM invocation starts |
| `llm_response` | LLM invocation completes |
| `tool_call` | MCP tool is invoked (future) |
| `tool_result` | MCP tool returns a result (future) |
| `state_change` | Agent status changes (e.g. failed with reason) |

Query: `SELECT * FROM audit_event WHERE agent_id = $1 ORDER BY timestamp`.

---

## Health check

`GET http://localhost:3001/health` — checks PostgreSQL connectivity and Redis connectivity. Returns HTTP 200 when both are up, 503 when either is down.
