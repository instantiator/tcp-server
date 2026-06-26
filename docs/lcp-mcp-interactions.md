# lcp-mcp-interactions

**Status:** Implemented
**Port:** 3012
**Transport:** MCP Streamable HTTP — stateless, one session per request

`lcp-mcp-interactions` is a NestJS MCP server that lets agents pause and coordinate — either requesting input from a human user or dispatching a question to another agent role. It lives in `apps/lcp-mcp-interactions/` and runs as a Docker Compose service.

When an agent calls `request_user_input` or `request_agent_consultation`, lcp-agent detects the pause signal on the next iteration of its event loop and exits the stream cleanly, freeing resources. The BullMQ job is considered complete. The agent resumes automatically once a reply arrives.

Each tool call writes `tool_call` and `tool_result` audit events to lcp-server via the internal audit endpoint.

See [agent-services.md → MCP Servers](agent-services.md#mcp-servers) for how agents connect. See [ADR-012](ADRs/ADR-012-human-in-the-loop.md) for the full design, and [conversations.md](conversations.md) for the end-to-end human-in-the-loop flow.

---

## Tools

| Tool                                                        | Signature                                                                      | Description                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------ |
| [`describe_server`](#describe_server)                       | `describe_server()`                                                            | Overview of the interactions service       |
| [`list_available_users`](#list_available_users)             | `list_available_users(companyId)`                                              | List human users registered in the company |
| [`list_available_roles`](#list_available_roles)             | `list_available_roles(companyId)`                                              | List agent roles that can be consulted     |
| [`request_user_input`](#request_user_input)                 | `request_user_input(agentId, companyId, question, context?)`                   | Pause and submit a question to human users |
| [`request_agent_consultation`](#request_agent_consultation) | `request_agent_consultation(agentId, companyId, roleName, question, context?)` | Consult another agent role                 |
| [`complete_task`](#complete_task)                           | `complete_task(agentId, companyId, finalAnswer)`                               | Mark the task complete with a summary      |

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

| Parameter   | Type   | Required | Description                                                 |
| ----------- | ------ | -------- | ----------------------------------------------------------- |
| `agentId`   | UUID   | yes      | The calling agent's UUID                                    |
| `companyId` | UUID   | yes      | The company UUID                                            |
| `question`  | string | yes      | The question to ask the user (shown in `list-open-queries`) |
| `context`   | string | no       | Optional background context to help the user respond        |

**Returns:** A confirmation message containing the conversation slug (e.g. `"Paused. Query submitted as analyst-3. Your task will resume when the user responds."`).

**What happens internally:**

1. `POST /internal/pause` on lcp-server — creates a `Conversation` record (status `awaiting_user`), sets `LcpAgent.status = paused`, routes the query to relevant users based on their `knowledgeDomains`
2. Returns the conversation slug to the agent
3. lcp-agent detects the `paused` status on its next loop iteration and exits the event stream cleanly
4. When a user responds (`respond <slug> "message"`), lcp-server re-enqueues the agent job with the reply injected as a `HumanMessage`

**Query routing:** The conversation is routed to users whose `knowledgeDomains` or `roles` match keywords in the question. If no user matches, all company owners receive it as a fallback.

---

## `request_agent_consultation`

Pauses the current agent and dispatches a consultation job to another agent role. The calling agent is automatically resumed with the consulting agent's response once it calls `complete_task`.

**Arguments:**

| Parameter   | Type   | Required | Description                                  |
| ----------- | ------ | -------- | -------------------------------------------- |
| `agentId`   | UUID   | yes      | The calling agent's UUID                     |
| `companyId` | UUID   | yes      | The company UUID                             |
| `roleName`  | string | yes      | The name of the role to consult              |
| `question`  | string | yes      | The question to pose to the consulting agent |
| `context`   | string | no       | Optional context for the consultation        |

**Returns:** A confirmation message containing the consultation ID.

**What happens internally:**

1. `POST /internal/pause` on lcp-server — creates a `PendingConsultation` record, sets the calling agent to `paused`, enqueues a new agent job for the target role with a supplementary context prompt: `"This is a consultation from {callingRoleName}. Give a complete, concise answer in a single response."`
2. When the consulting agent calls `complete_task`, lcp-server sets the calling agent back to `active` and re-enqueues it with the consultation result injected as a `HumanMessage`

---

## `complete_task`

Marks the current agent task as complete and stores a final answer summary. Agents must call this as their last action before their task ends.

**Arguments:**

| Parameter     | Type   | Required | Description                                                                          |
| ------------- | ------ | -------- | ------------------------------------------------------------------------------------ |
| `agentId`     | UUID   | yes      | The calling agent's UUID                                                             |
| `companyId`   | UUID   | yes      | The company UUID                                                                     |
| `finalAnswer` | string | yes      | A concise, human-readable summary of what was accomplished and any output file paths |

**Returns:** A completion acknowledgement (e.g. `"Task marked complete. Well done."`).

**What happens internally:** `POST /internal/agent/:agentId/complete` — sets `LcpAgent.status = completed` and stores `finalAnswer` as `LcpAgent.output`. For consultation agents, this also triggers the calling agent's resume.

**Completion enforcement:** If the agent loop exits without having called `complete_task` and iterations remain, lcp-agent injects one final HumanMessage instructing the agent to call `complete_task`. If still not called, lcp-agent sets the status to `completed` with the last AI message as the output, and logs a warning.

---

## Pause and resume flow

```
Agent calls request_user_input / request_agent_consultation
  → lcp-agent POSTs /internal/pause
  → lcp-server creates Conversation or PendingConsultation record
  → lcp-server sets LcpAgent.status = paused
  → lcp-agent detects paused status on next loop tick
  → lcp-agent exits stream, BullMQ job completes normally

[User replies via CLI respond / API]
  → lcp-server POSTs /internal/agent/resume/:agentId
  → lcp-server re-enqueues agent job with reply injected
  → lcp-agent resumes from checkpoint with HumanMessage containing the reply
```

See [conversations.md](conversations.md) for the full human-in-the-loop sequence diagram.

---

## Deferred

| Item                         | Description                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| User-initiated conversations | `POST /conversations` for user-to-agent threads outside the normal task pipeline — deferred |
| WebSocket transport          | Real-time bidirectional conversation UX — deferred                                          |
| Teaching flow                | `{ teach: 'memory' \| 'knowledge' }` in replies to trigger memory or KB writes — deferred   |
