# lcp-mcp-interactions

**Status:** Stub — all tools return "not yet implemented" responses
**Port:** 3012
**Transport:** MCP Streamable HTTP — stateless, one session per request

`lcp-mcp-interactions` is a NestJS MCP server intended to let agents pause and request input — either from a human user or from another agent playing a different role. It lives in `apps/lcp-mcp-interactions/` and runs as a Docker Compose service.

All tools are currently stubs. Agents can call them without errors, but they receive an informative "not yet implemented" message and the agent continues running rather than suspending.

The full implementation requires LangGraph `interrupt()` support for agent suspension, a `Conversation` entity for tracking pending requests, and SSE events to notify clients that a response is needed. See [ADR-012](ADRs/ADR-012-human-in-the-loop.md) for the full design.

See [agent-services.md → MCP Servers](agent-services.md#mcp-servers) for how agents connect.

---

## Tools

| Tool                                                        | Signature                                                   | Status | Description                                        |
| ----------------------------------------------------------- | ----------------------------------------------------------- | ------ | -------------------------------------------------- |
| [`describe_server`](#describe_server)                       | `describe_server()`                                         | Stub   | Overview of the interactions service and its tools |
| [`request_user_input`](#request_user_input)                 | `request_user_input(question, context?)`                    | Stub   | Pause and request input from a human user          |
| [`request_agent_consultation`](#request_agent_consultation) | `request_agent_consultation(role_name, question, context?)` | Stub   | Consult another agent by role                      |

---

## `describe_server`

Returns a markdown overview of the interactions service and its tools.

**Arguments:** none

**Returns:** Markdown text listing all tools. The description notes that tools are stubs.

**Usage pattern:** Agents should call this first when they discover the interactions server is available. Prompt part 3 directs agents to do this automatically.

---

## `request_user_input`

Intended to suspend the current agent run and send a request to the human user for additional input. The agent would resume automatically once the user responds.

**Arguments:**

| Parameter  | Type   | Required | Description                                              |
| ---------- | ------ | -------- | -------------------------------------------------------- |
| `question` | string | yes      | The question to ask the user                             |
| `context`  | string | no       | Optional context to help the user understand the request |

**Current behaviour (stub):** Returns `"User input requests are not yet implemented."` The agent is not suspended and continues running.

**Planned behaviour:**

1. Create a `Conversation` record in the database (`status: pending_user_input`, agent ID, question, context).
2. Emit a `user_input_requested` SSE event on `GET /api/agent/:id/events`.
3. Call LangGraph `interrupt()` to suspend the agent at the current graph node.
4. When the user responds via `POST /api/conversation/:id/reply`, resume the agent with the reply injected as the next message.

---

## `request_agent_consultation`

Intended to pause the current agent run and dispatch a question to another agent running a different role. The calling agent would resume with the consulting agent's response once it completes.

**Arguments:**

| Parameter   | Type   | Required | Description                                  |
| ----------- | ------ | -------- | -------------------------------------------- |
| `role_name` | string | yes      | The role name of the agent to consult        |
| `question`  | string | yes      | The question to pose to the consulting agent |
| `context`   | string | no       | Optional context for the consultation        |

**Current behaviour (stub):** Returns `"Agent consultation is not yet implemented."` The calling agent is not suspended.

**Planned behaviour:**

1. Look up the role by name within the same company.
2. Create a new `LcpAgent` of type `consultation` with the question as its `initialPrompt`.
3. Enqueue it on the `agent-jobs` BullMQ queue.
4. Suspend the calling agent via LangGraph `interrupt()`.
5. When the consulting agent completes, inject its response into the calling agent's context and resume it.

---

## Relationship to ADR-012

[ADR-012](ADRs/ADR-012-human-in-the-loop.md) covers the full human-in-the-loop design including the `Conversation` data model, SSE event schema, and the LangGraph interruption/resumption flow. The interactions MCP server is the agent-facing surface of that design — it gives agents a tool-based API to trigger these flows without needing to know the underlying implementation.
