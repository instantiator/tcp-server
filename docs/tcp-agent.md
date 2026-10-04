# tcp-agent

The `tcp-agent` service runs the LangGraph agent loop. It consumes jobs from the `agent-jobs` BullMQ queue and executes or resumes an agent run for each job.

---

## How it works

1. **tcp-server** creates an `TcpAgent` record and enqueues a job: `{ agentId, type: 'start' | 'resume' }`.
2. **tcp-agent's** `AgentWorkerService` picks up the job and calls `AgentLoopService.run(agentId)`.
3. `AgentLoopService`:
   - Loads the `TcpAgent` and its `TcpRole` from the shared PostgreSQL database.
   - Sets the agent status to `running`.
   - Opens a `PostgresSaver` checkpoint store (LangGraph resumability).
   - Builds a `StateGraph` (`buildAgentGraph` in `@tcp/shared`) with an `agent` node that invokes the configured LLM, plus a conditional `tools` node when the role's mode has any MCP tools.
   - Streams graph events; writes an `AuditEvent` row for each LLM request/response.
   - After the stream: validates that the agent produced non-empty output; retries once if not.
   - Sets the final status to `completed` or `failed`.
   - Cleans up: closes the checkpoint pool, deregisters the agent from the in-memory registry.

---

## Authentication

All `tcp-server` API endpoints (`/api/*`) require a Bearer token from your OIDC provider. Obtain one from Zitadel via `tcp-cli get-token` (device-flow login; see [zitadel-setup.md](zitadel-setup.md)) and pass it in every request:

```text
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
      "baseUrl": "http://host.docker.internal:1234/v1",
      "apiKey": "your-lm-studio-token"
    }
  }'
```

**Fallback rules** (see `LlmConfigResolver` in `@tcp/shared`):

1. If the role has its own `llmConfig`, that is used.
2. Otherwise the company's `llmConfig` is used.
3. Otherwise the server/agent environment's `LLM_PROVIDER`/`LLM_MODEL` fallback is used.
4. If none of the three is set, the agent run fails immediately with status `failed`.

A role with no `llmConfig` and a company with no `llmConfig` are both accepted at create/update time — the environment fallback (or a failed run, if that's also unset) covers it at run time. The only check up front is where `baseUrl` points (see below).

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
      "baseUrl": "http://host.docker.internal:1234/v1",
      "apiKey": "your-lm-studio-token"
    },
    "systemPromptTemplate": "You are {{name}}, a specialist at {{description}}. It is {{datetime}} — you are in region {{timezone}}, where the local time is {{localDatetime}}."
  }'
```

`apiKey` holds the API key for the provider. It is stored in the database as part of the JSONB config block and masked (`***`) in API responses by default. Set `TCP_MASK_API_KEYS=false` in the environment to expose raw keys during local debugging.

`baseUrl` is checked when a company or role is saved, because the server will connect to it. A remote provider (`openai`, `anthropic` and so on) must use its own URL from the [provider catalogue](../libs/tcp-shared/src/llm/provider-catalogue.ts), or leave `baseUrl` out. A local or custom provider (`lm-studio`, `ollama`, `openai-compatible`) may only use a host listed in `LLM_ALLOWED_HOSTS`, or the host of `LLM_BASE_URL` / `EMBEDDING_BASE_URL`. Anything else is a 400. A change of `baseUrl` or `provider` that doesn't send a new `apiKey` drops the stored one, so a key is never sent to a different address than it was set for.

`systemPromptTemplate` is optional — a blank or omitted value resolves via `SystemPromptTemplateResolver`: the role's own template, then the company's, then a baked-in default (`DEFAULT_SYSTEM_PROMPT_TEMPLATE`).

### Template placeholders

| Placeholder         | Value                                                                         |
| ------------------- | ----------------------------------------------------------------------------- |
| `{{name}}`          | `TcpRole.name`                                                                |
| `{{description}}`   | `TcpRole.description`                                                         |
| `{{date}}`          | Current UTC date, `YYYY-MM-DD` (kept for older templates)                     |
| `{{datetime}}`      | Current UTC date and time, explicitly labeled — the LLM's authoritative "now" |
| `{{timezone}}`      | The company's IANA timezone name, or `UTC` when unset                         |
| `{{localDatetime}}` | `{{datetime}}` localized to `{{timezone}}`; equals `{{datetime}}` when unset  |
| `{{companyId}}`     | `TcpAgent.companyId` — for tool calls that require it                         |
| `{{roleId}}`        | `TcpRole.id` — for tool calls that require it                                 |

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

Returns the `TcpAgent` record. Poll `GET /api/agent/:id` to track status.

---

## Resuming an agent

```bash
curl -X POST http://localhost:3000/api/agent/resume/:id \
  -H "Authorization: Bearer <token>"
```

Valid from status `idle`, `paused`, or `failed`. Re-enqueues the agent; the LangGraph checkpoint store restores prior conversation state.

---

## Checking model compatibility

Before assigning a role to a model, verify that the model supports the required capabilities. The route is for administrators only (`TCP_ADMIN_IDENTIFIERS`), because the server connects to the `baseUrl` it's given. That address must also pass the same `baseUrl` check as a saved config (see [Creating a role](#creating-a-role)).

```bash
curl -X POST http://localhost:3000/api/model/check \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "models": [
      {
        "provider": "lm-studio",
        "model": "qwen3-5b",
        "baseUrl": "http://host.docker.internal:1234/v1",
        "apiKey": "your-lm-studio-token"
      }
    ]
  }'
```

Returns `{ provider, model, supportsTools, supportsStructuredOutput, compatible, error?, errorCode? }` for each model. `compatible` is `true` if both tool-calling and structured output are confirmed.

A model that refuses the tool definition or the output schema just reports that capability as `false`. When the check can't be completed, `errorCode` says why and `error` says what to check:

| `errorCode`            | Meaning                                                                  |
| ---------------------- | ------------------------------------------------------------------------ |
| `unsupported_provider` | `provider` isn't in the catalogue                                        |
| `destination_refused`  | `baseUrl` isn't allowed; nothing was sent                                |
| `unreachable`          | Nothing answered at `baseUrl` (from Docker, use `host.docker.internal`)  |
| `timeout`              | No answer within `timeoutMs`; a local model may still be loading         |
| `auth_rejected`        | HTTP 401: the API key is wrong or missing                                |
| `forbidden`            | HTTP 403: the key can't use this model                                   |
| `model_not_found`      | HTTP 404: wrong model name, model not loaded, or `baseUrl` missing `/v1` |
| `rate_limited`         | HTTP 429: rate limit or quota                                            |
| `provider_error`       | HTTP 5xx: a fault at the provider                                        |
| `failed`               | Anything else; the server log has the detail                             |

The provider's own error text is never returned, only logged, so the route can't be used to read what an address sends back.

---

## Resource limits

Each limit resolves role → company → environment → code default, via
`runConfig` and `resolveRunConfig` (`@tcp/shared`):

| Limit                        | `runConfig` key | Env override            | Default |
| ---------------------------- | --------------- | ----------------------- | ------- |
| Max LLM invocations per run  | `maxIterations` | `AGENT_ITERATIONS`      | 40      |
| Wall-clock timeout for a run | `timeoutMs`     | `AGENT_LOOP_TIMEOUT_MS` | 30 min  |
| Timeout for one LLM call     | —               | `LLM_TIMEOUT_MS`        | 30 min  |

The run-level timeout is deliberately kept at or above the per-call timeout: a
shorter one would abort the run before a single legitimate call could finish.
Defaults live in `libs/tcp-shared/src/config/defaults.ts`.

To estimate a role's worst-case initial-prompt token footprint against its
LLM's context window before running it, see `tcp-cli`'s
[`estimate-context-window`](tcp-cli.md#estimate-context-window) — it reuses
the same `ContextBudgetService` used at runtime to decide when to compact context.

---

## MCP tools

Before running the LangGraph loop, `AgentLoopService` connects to each MCP server listed in `role.mcpServerList` and loads its tools. Tools are exposed to the model as `{serverName}__{toolName}` (e.g. `storage__list_files`) to prevent collisions across servers. If a server is unreachable, it is silently skipped and the agent runs with whatever tools did load.

MCP server URLs are resolved from environment variables:

| Variable               | Server                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `MCP_STORAGE_URL`      | [tcp-mcp-storage](tcp-mcp-storage.md) — shared-storage exploration, working files, materials  |
| `MCP_MEMORY_URL`       | [tcp-mcp-memory](tcp-mcp-memory.md) — episodic memory and knowledge search                    |
| `MCP_INTERACTIONS_URL` | [tcp-mcp-interactions](tcp-mcp-interactions.md) — user input and agent consultation           |
| `MCP_TASKS_URL`        | [tcp-mcp-tasks](tcp-mcp-tasks.md) — plan a task, submit finished work, assure QA (mode-gated) |

Which of the loaded servers an agent actually gets is then narrowed by its
mode — `MODE_TOOLS` in `@tcp/shared` is the single source of truth (see
[tasks.md → Agent modes](tasks.md#agent-modes)).

See [agent-services.md → MCP Servers](agent-services.md#mcp-servers) for configuration details.

---

## In-loop tracking

While the agent loop runs, `AgentLoopService` maintains an in-memory tracker that accumulates two things:

**Action log** — a human-readable ordered list of tool invocations, e.g. `"Wrote file: docs/report.md"`, `"Requested user input: What is the budget?"`. Populated on every `on_tool_start` event, including failed tool calls.

**Storage changes** — structured record of MinIO mutations: `created`, `modified`, `deleted`, and `moved` file paths. Populated on `on_tool_end` events by inspecting the tool result text (e.g. `"Written:"`, `"Deleted:"`, `"Moved:"`).

After each storage `on_tool_end`, the tracker is persisted to `TcpAgent.storageChanges` via a fire-and-forget `PATCH /internal/agent/:id/storage` to tcp-server. This makes the data available to the completion gate's file-validation error messages without in-process coupling.

---

## Audit events

Every agent run produces `AuditEvent` rows in the `audit_event` table:

| Event type              | When                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `llm_request`           | LLM invocation starts                                                              |
| `llm_response`          | LLM invocation completes                                                           |
| `tool_call`             | MCP tool is invoked                                                                |
| `tool_result`           | MCP tool returns a result                                                          |
| `state_change`          | An agent, assignment, task or company changes state (`payload.entity` says which)  |
| `agent_loop_completion` | Agent loop ends via its required completion tool — structured summary + action log |
| `compaction`            | Context-window compaction started or completed (`payload.phase`)                   |
| `input`                 | User-submitted text — a chat message or a conversation answer                      |
| `decision`              | An explicitly recorded decision                                                    |

These rows are also the live stream: `AuditService.write` persists each one and
then publishes it as a `WireEvent` on the relevant SSE channel, so history
replay and a live tail render identically. See
[ADR-008](ADRs/ADR-008-audit-logging.md).

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

Query: `SELECT * FROM audit_event WHERE "agentId" = $1 ORDER BY timestamp`.

---

## Health check

`GET http://localhost:3001/health` — checks PostgreSQL connectivity and Redis connectivity. Returns HTTP 200 when both are up, 503 when either is down.

The Redis check uses the shared bounded `assertRedisReachable` probe, so it cannot hang. tcp-agent also fails fast at **startup** if Redis is unreachable (`AgentWorkerService.onModuleInit`): rather than letting the BullMQ worker block indefinitely against a downed broker, it throws a clear error. `main.ts` calls `app.enableShutdownHooks()` so the worker and its Redis connection close cleanly on `SIGTERM`.

tcp-agent needs no MinIO configuration and is given no MinIO credentials: it never constructs an S3 client. Every storage action it takes — like every other service's — goes through tcp-server's `StorageService` behind the `/internal/storage/*` endpoints.
