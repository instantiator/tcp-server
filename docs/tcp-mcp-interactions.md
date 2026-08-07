# tcp-mcp-interactions

**Status:** Implemented
**Port:** 3012
**Transport:** MCP Streamable HTTP — stateless, one session per request

`tcp-mcp-interactions` is a NestJS MCP server that lets agents pause and coordinate — either requesting input from a human user or dispatching a question to another agent role. It lives in `apps/tcp-mcp-interactions/` and runs as a Docker Compose service.

When an agent calls `request_user_input` or `request_agent_consultation`, tcp-agent detects the pause signal on the next iteration of its event loop and exits the stream cleanly, freeing resources. The BullMQ job is considered complete. The agent resumes automatically once a reply arrives.

Each tool call writes `tool_call` and `tool_result` audit events to tcp-server via the internal audit endpoint.

See [agent-services.md → MCP Servers](agent-services.md#mcp-servers) for how agents connect. See [ADR-012](ADRs/ADR-012-human-in-the-loop.md) for the full design, [user-input-conversations.md](user-input-conversations.md) for the agent-to-human flow, and [cross-agent-consultations.md](cross-agent-consultations.md) for the agent-to-agent flow.

**`agentId`/`companyId` are not LLM-suppliable.** The signatures below are this server's published MCP schema, but `McpClientService` (see [agent-services.md](agent-services.md#enabling-mcp-tools-for-a-role)) strips `agentId`/`companyId` from what the calling LLM actually sees and injects the real values on every call. The LLM has no reliable way to know its own `agentId`, and trusting it to supply one is also a correctness/security gap — it could otherwise assert a different agent's id.

---

## Tools

| Tool                                                        | Signature                                                                               | Description                                                  |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [`describe_server`](#describe_server)                       | `describe_server()`                                                                     | Overview of the interactions service                         |
| [`list_available_contacts`](#list_available_contacts)       | `list_available_contacts(companyId, kind?)`                                             | List human users and/or agent roles available to ask/consult |
| [`request_user_input`](#request_user_input)                 | `request_user_input(agentId, companyId, question, context?, userIds?)`                  | Pause and submit a question to human users                   |
| [`request_agent_consultation`](#request_agent_consultation) | `request_agent_consultation(agentId, companyId, roleId, question, context?, roleName?)` | Consult another agent role                                   |

Assignment completion moved to [tcp-mcp-tasks](tcp-mcp-tasks.md) (`complete_assignment`) in task-orchestration part 5 — this server no longer owns a `complete_task` tool.

---

## `describe_server`

Returns a markdown overview of the interactions service and its tools.

**Arguments:** none

**Returns:** Markdown text listing all tools and usage guidance.

**Usage pattern:** useful when an agent wants an orientation on what the interactions server offers. It is not a precondition for anything.

**Note:** all of this server's tools are bound to the model from turn 1 — the describe-then-reveal gating that used to delay non-`describe_server` tools until first use was removed in 010.2.8.2 (see [ADR-013 Amendments](ADRs/ADR-013-prompt-assembly-context-management.md#amendments-as-implemented-010282)). Before that removal, `interactions` was already exempt from the gating, since `request_user_input` and `request_agent_consultation` are essential control-flow calls that must stay reachable at all times.

---

## `list_available_contacts`

Lists the human users and/or agent roles available in the company — users can be asked questions via `request_user_input`, roles can be consulted via `request_agent_consultation`. Replaces the earlier separate `list_available_users`/`list_available_roles` tools with one call (fewer iterations, smaller schema footprint).

**Arguments:**

| Parameter   | Type                               | Required | Description                                                                 |
| ----------- | ---------------------------------- | -------- | --------------------------------------------------------------------------- |
| `companyId` | UUID                               | yes      | The company to query                                                        |
| `kind`      | `'users'` \| `'roles'` \| `'both'` | no       | Which contacts to list (case/whitespace-insensitive). Defaults to `'both'`. |

**Returns:** With `kind: 'users'` or `kind: 'roles'`, the raw JSON array for that collection (same shape as before):

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

With `kind: 'both'` (or omitted), a JSON object keyed by collection: `{ "users": [...], "roles": [...] }`. If one collection's lookup fails, that key holds `{ "error": "..." }` instead — the other collection's data is still returned.

---

## `request_user_input`

Pauses the current agent and submits a question to the relevant human users in the company. The agent is automatically resumed once a user replies via `POST /api/conversation/:slug/reply` or the `respond` CLI command.

**Arguments:**

| Parameter   | Type   | Required | Description                                                                                            |
| ----------- | ------ | -------- | ------------------------------------------------------------------------------------------------------ |
| `agentId`   | UUID   | yes      | The calling agent's UUID                                                                               |
| `companyId` | UUID   | yes      | The company UUID                                                                                       |
| `question`  | string | yes      | The question to ask the user (shown in `list-open-queries`)                                            |
| `context`   | string | no       | Optional background context to help the user respond                                                   |
| `userIds`   | UUID[] | no       | Company user ids (from `list_available_contacts`) to target. Omit to auto-route based on the question. |

**Returns:** A confirmation message containing the conversation slug (e.g. `"Paused. Query submitted as analyst-3. Your task will resume when the user responds."`).

**What happens internally:**

1. `POST /internal/pause` on tcp-server — creates a `Conversation` record (status `awaiting_user`), sets `TcpAgent.status = paused`, routes the query to `userIds` directly if given, otherwise based on matching `knowledgeDomains`/`roles`
2. Returns the conversation slug to the agent
3. tcp-agent detects the `paused` status on its next loop iteration and exits the event stream cleanly
4. When a user responds (`respond <slug> "message"`), tcp-server attempts to resume the agent — see [Resume conditions](cross-agent-consultations.md#resume-conditions)

**Query routing:** See [user-input-conversations.md](user-input-conversations.md#data-model) for the full routing rules.

---

## `request_agent_consultation`

Pauses the current agent and dispatches a consultation job to another agent role. The calling agent is automatically resumed with the consulting agent's response once it calls `complete_assignment` (on the [tasks](tcp-mcp-tasks.md) service).

**Arguments:**

| Parameter   | Type   | Required | Description                                                                                                                             |
| ----------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `agentId`   | UUID   | yes      | The calling agent's UUID                                                                                                                |
| `companyId` | UUID   | yes      | The company UUID                                                                                                                        |
| `roleId`    | UUID   | yes      | The id of the role to consult (from `list_available_contacts`) — role names aren't unique within a company, so the id is the lookup key |
| `question`  | string | yes      | The question to pose to the consulting agent                                                                                            |
| `context`   | string | no       | Optional context for the consultation                                                                                                   |
| `roleName`  | string | no       | Optional human-readable label, used only for friendlier logging                                                                         |

**Returns:** A confirmation message containing the consultation ID and the resolved role name.

**What happens internally:**

1. `POST /internal/pause` on tcp-server — looks up the role by `roleId` (scoped to `companyId`), creates a `PendingConsultation` record, sets the calling agent to `paused`, starts a new agent job for the target role with a supplementary context prompt: `"This is a consultation from {callingRoleName}. Give a complete, concise answer in a single response."`
2. When the consulting agent calls `complete_assignment`, tcp-server attempts to resume the calling agent with the consultation result — see [Resume conditions](cross-agent-consultations.md#resume-conditions)
3. Consulting agents are created with `requiredToolCalls: ['complete_assignment']`. If the consultation fails (error, timeout, or the required call never fires despite reminders), the calling agent is resumed with a `Consultation FAILED: <reason>` message instead of staying paused — see [Consultation failure](cross-agent-consultations.md#consultation-failure)

---

## Pause and resume flow

```
Agent calls request_user_input / request_agent_consultation
  → tcp-agent POSTs /internal/pause
  → tcp-server creates Conversation or PendingConsultation record
  → tcp-server sets TcpAgent.status = paused, pausedAt = now()
  → tcp-agent detects paused status on next loop tick
  → tcp-agent exits stream, BullMQ job completes normally

[User replies via CLI respond / API, or a consultation agent completes]
  → tcp-server calls AgentOrchestrationService.resumeAgent(agentId)
  → stays paused if other requests are still outstanding (see Resume conditions)
  → otherwise re-enqueues the agent job with every response since pausedAt aggregated
  → tcp-agent resumes from checkpoint with HumanMessage containing the aggregated reply
```

See [user-input-conversations.md](user-input-conversations.md) for the agent-to-human sequence diagram and [cross-agent-consultations.md](cross-agent-consultations.md) for the agent-to-agent one, including [resume conditions](cross-agent-consultations.md#resume-conditions).

---

## Deferred

| Item                         | Description                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| User-initiated conversations | `POST /conversations` for user-to-agent threads outside the normal task pipeline — deferred |
| WebSocket transport          | Real-time bidirectional conversation UX — deferred                                          |
| Teaching flow                | `{ teach: 'memory' \| 'knowledge' }` in replies to trigger memory or KB writes — deferred   |
