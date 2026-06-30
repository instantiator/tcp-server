# lcp-mcp-interactions

**Status:** Implemented
**Port:** 3012
**Transport:** MCP Streamable HTTP — stateless, one session per request

`lcp-mcp-interactions` is a NestJS MCP server that lets agents pause and coordinate — either requesting input from a human user or dispatching a question to another agent role. It lives in `apps/lcp-mcp-interactions/` and runs as a Docker Compose service.

When an agent calls `request_user_input` or `request_agent_consultation`, lcp-agent detects the pause signal on the next iteration of its event loop and exits the stream cleanly, freeing resources. The BullMQ job is considered complete. The agent resumes automatically once a reply arrives.

Each tool call writes `tool_call` and `tool_result` audit events to lcp-server via the internal audit endpoint.

See [agent-services.md → MCP Servers](agent-services.md#mcp-servers) for how agents connect. See [ADR-012](ADRs/ADR-012-human-in-the-loop.md) for the full design, [user-input-conversations.md](user-input-conversations.md) for the agent-to-human flow, and [cross-agent-consultations.md](cross-agent-consultations.md) for the agent-to-agent flow.

**`agentId`/`companyId` are not LLM-suppliable.** The signatures below are this server's published MCP schema, but `McpClientService` (see [agent-services.md](agent-services.md#enabling-mcp-tools-for-a-role)) strips `agentId`/`companyId` from what the calling LLM actually sees and injects the real values on every call. The LLM has no reliable way to know its own `agentId`, and trusting it to supply one is also a correctness/security gap — it could otherwise assert a different agent's id.

---

## Tools

| Tool                                                        | Signature                                                                      | Description                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| [`describe_server`](#describe_server)                       | `describe_server()`                                                            | Overview of the interactions service                         |
| [`list_available_users`](#list_available_users)             | `list_available_users(companyId)`                                              | List human users registered in the company                   |
| [`list_available_roles`](#list_available_roles)             | `list_available_roles(companyId)`                                              | List agent roles that can be consulted                       |
| [`request_user_input`](#request_user_input)                 | `request_user_input(agentId, companyId, question, context?, userIds?)`         | Pause and submit a question to human users                   |
| [`request_agent_consultation`](#request_agent_consultation) | `request_agent_consultation(agentId, companyId, roleId, question, context?, roleName?)` | Consult another agent role                                   |
| [`complete_task`](#complete_task)                           | `complete_task(agentId, companyId, finalAnswer, outputFiles?)`                 | Mark the task complete; optionally verify output files exist |

---

## `describe_server`

Returns a markdown overview of the interactions service and its tools.

**Arguments:** none

**Returns:** Markdown text listing all tools and usage guidance.

**Usage pattern:** Agents should call this first when they discover the interactions server is available. Prompt part 3 directs agents to do this automatically.

---

## `list_available_users`

Lists the human users registered in the company, including their roles and knowledge domains. Useful before calling `request_user_input` to know who will be notified.

**Arguments:**

| Parameter   | Type | Required | Description          |
| ----------- | ---- | -------- | -------------------- |
| `companyId` | UUID | yes      | The company to query |

**Returns:** JSON array of user records:

```json
[
  {
    "id": "...",
    "name": "Alice",
    "identifier": "alice@example.com",
    "memberType": "owner",
    "roles": ["strategy", "operations"],
    "knowledgeDomains": ["finance", "compliance"]
  }
]
```

---

## `list_available_roles`

Lists the agent roles defined in the company that can be consulted via `request_agent_consultation`.

**Arguments:**

| Parameter   | Type | Required | Description          |
| ----------- | ---- | -------- | -------------------- |
| `companyId` | UUID | yes      | The company to query |

**Returns:** JSON array of role records (name, slug, description).

---

## `request_user_input`

Pauses the current agent and submits a question to the relevant human users in the company. The agent is automatically resumed once a user replies via `POST /api/conversation/:slug/reply` or the `respond` CLI command.

**Arguments:**

| Parameter   | Type     | Required | Description                                                              |
| ----------- | -------- | -------- | ------------------------------------------------------------------------- |
| `agentId`   | UUID     | yes      | The calling agent's UUID                                                  |
| `companyId` | UUID     | yes      | The company UUID                                                          |
| `question`  | string   | yes      | The question to ask the user (shown in `list-open-queries`)               |
| `context`   | string   | no       | Optional background context to help the user respond                     |
| `userIds`   | UUID[]   | no       | Company user ids (from `list_available_users`) to target. Omit to auto-route based on the question. |

**Returns:** A confirmation message containing the conversation slug (e.g. `"Paused. Query submitted as analyst-3. Your task will resume when the user responds."`).

**What happens internally:**

1. `POST /internal/pause` on lcp-server — creates a `Conversation` record (status `awaiting_user`), sets `LcpAgent.status = paused`, routes the query to `userIds` directly if given, otherwise based on matching `knowledgeDomains`/`roles`
2. Returns the conversation slug to the agent
3. lcp-agent detects the `paused` status on its next loop iteration and exits the event stream cleanly
4. When a user responds (`respond <slug> "message"`), lcp-server attempts to resume the agent — see [Resume conditions](cross-agent-consultations.md#resume-conditions)

**Query routing:** See [user-input-conversations.md](user-input-conversations.md#data-model) for the full routing rules.

---

## `request_agent_consultation`

Pauses the current agent and dispatches a consultation job to another agent role. The calling agent is automatically resumed with the consulting agent's response once it calls `complete_task`.

**Arguments:**

| Parameter   | Type   | Required | Description                                                              |
| ----------- | ------ | -------- | --------------------------------------------------------------------------- |
| `agentId`   | UUID   | yes      | The calling agent's UUID                                                    |
| `companyId` | UUID   | yes      | The company UUID                                                            |
| `roleId`    | UUID   | yes      | The id of the role to consult (from `list_available_roles`) — role names aren't unique within a company, so the id is the lookup key |
| `question`  | string | yes      | The question to pose to the consulting agent                                |
| `context`   | string | no       | Optional context for the consultation                                       |
| `roleName`  | string | no       | Optional human-readable label, used only for friendlier logging              |

**Returns:** A confirmation message containing the consultation ID and the resolved role name.

**What happens internally:**

1. `POST /internal/pause` on lcp-server — looks up the role by `roleId` (scoped to `companyId`), creates a `PendingConsultation` record, sets the calling agent to `paused`, starts a new agent job for the target role with a supplementary context prompt: `"This is a consultation from {callingRoleName}. Give a complete, concise answer in a single response."`
2. When the consulting agent calls `complete_task`, lcp-server attempts to resume the calling agent with the consultation result — see [Resume conditions](cross-agent-consultations.md#resume-conditions)

---

## `complete_task`

Marks the current agent task as complete and stores a final answer summary. Agents must call this as their last action before their task ends.

**Arguments:**

| Parameter     | Type     | Required | Description                                                                          |
| ------------- | -------- | -------- | ------------------------------------------------------------------------------------ |
| `agentId`     | UUID     | yes      | The calling agent's UUID                                                             |
| `companyId`   | UUID     | yes      | The company UUID                                                                     |
| `finalAnswer` | string   | yes      | A concise, human-readable summary of what was accomplished and any output file paths |
| `outputFiles` | string[] | no       | Paths in shared storage produced by this task — each is verified to exist in MinIO   |

**Returns:** A completion acknowledgement on success. If `outputFiles` is supplied and any path is missing from MinIO, returns a canned error listing the missing files alongside the files created or modified during the run — the agent should correct the paths or continue working before calling again.

**What happens internally:**

1. If `outputFiles` is non-empty, queries lcp-mcp-storage `GET /files/exists` for each path. Missing paths trigger the error response (no completion written). Fails open — if lcp-mcp-storage is unreachable, completion proceeds.
2. On success: `POST /internal/agent/:agentId/complete` — sets `LcpAgent.status = completed` and stores `finalAnswer` as `LcpAgent.output`. For consultation agents, also triggers the calling agent's resume.
3. Records an `agent_loop_completion` audit event with a prose summary, the ordered action log, and storage changes (created, modified, deleted, moved files).

**Completion enforcement:** If the agent loop exits without having called `complete_task` and iterations remain, lcp-agent injects one final HumanMessage instructing the agent to call `complete_task`. If still not called, lcp-agent sets the status to `completed` with the last AI message as the output, and logs a warning.

---

## Pause and resume flow

```
Agent calls request_user_input / request_agent_consultation
  → lcp-agent POSTs /internal/pause
  → lcp-server creates Conversation or PendingConsultation record
  → lcp-server sets LcpAgent.status = paused, pausedAt = now()
  → lcp-agent detects paused status on next loop tick
  → lcp-agent exits stream, BullMQ job completes normally

[User replies via CLI respond / API, or a consultation agent completes]
  → lcp-server calls AgentOrchestrationService.resumeAgent(agentId)
  → stays paused if other requests are still outstanding (see Resume conditions)
  → otherwise re-enqueues the agent job with every response since pausedAt aggregated
  → lcp-agent resumes from checkpoint with HumanMessage containing the aggregated reply
```

See [user-input-conversations.md](user-input-conversations.md) for the agent-to-human sequence diagram and [cross-agent-consultations.md](cross-agent-consultations.md) for the agent-to-agent one, including [resume conditions](cross-agent-consultations.md#resume-conditions).

---

## Deferred

| Item                         | Description                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| User-initiated conversations | `POST /conversations` for user-to-agent threads outside the normal task pipeline — deferred |
| WebSocket transport          | Real-time bidirectional conversation UX — deferred                                          |
| Teaching flow                | `{ teach: 'memory' \| 'knowledge' }` in replies to trigger memory or KB writes — deferred   |
