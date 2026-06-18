# ADR-012: Human-in-the-Loop and User-Agent Conversations

Status: Proposed

## Context

LCP supports bidirectional interaction between users and agents:

1. **Agent-initiated pause**: a running agent needs input or clarification from a user before it can continue
2. **User-initiated conversation**: a user opens a thread with a role to teach it, ask it a question, or give it a direct task outside of the normal task pipeline
3. **User observation**: a user watches a task in progress — seeing the audit stream in real time

All conversations are **persisted** (for continuity and audit).

## Conversation modes

### 1. Agent-initiated pause

When a running agent needs user input:

1. Agent calls a `request_user_input(question, context?)` MCP tool
2. lcp-agent emits a `request_user_input` event to the `agent-results` queue
3. Orchestrator calls LangGraph's `interrupt()` on the current step — the graph is suspended
4. A `Conversation` record is created in the database, linked to the task step, with `status = awaiting_user`
5. The user is notified (visible via API polling or SSE subscription)
6. User responds via `POST /conversations/{id}/reply`
7. Orchestrator resumes the LangGraph graph, injecting the user's reply as the `interrupt` return value
8. Agent continues with the reply in its context

### 2. User-initiated conversation

A user can open a conversation thread with any role at any time, independent of a running task:

1. `POST /conversations` with `{ role_name, initial_message }` 
2. Orchestrator spins up a short-lived lcp-agent job using the specified role's config
3. The agent loop runs until the conversation is idle or explicitly closed
4. Each reply: `POST /conversations/{id}/reply` → queued to the agent job → response returned via SSE or polling

#### Teaching a role

If the user wants to teach the role (add to its memory or knowledge base):
- User includes `{ teach: true }` in their message
- On completion of the conversation turn, the orchestrator identifies the learned content and calls the memory MCP server's `remember()` tool, tagged with `source: 'user-teaching'`
- If the content is better suited as a KB document, the user can indicate `{ teach: 'knowledge' }` — the content is written as an OKF document to company storage and re-indexed (see [ADR-006](./ADR-006-agent-memory-architecture.md))

### 3. User observation (real-time audit stream)

A user can subscribe to the live audit log for any task step:

`GET /tasks/{task_id}/audit/stream` — SSE endpoint that pushes new `audit_events` rows as they are written

## Transport options

| Option | Notes |
|--------|-------|
| **REST + polling** | Simplest; user polls `/conversations/{id}` for new messages. Adequate but latency-limited. |
| **Server-Sent Events (SSE)** | Good for one-way streaming (agent output, audit log). Built into NestJS with `@Sse()`. |
| **WebSockets** | Full duplex; best for interactive conversation UX. More complex. |

## Decision

**SSE for streaming; REST for conversation turns** (initial implementation).

- Agent output and audit log observation: SSE (`@Sse()` in NestJS)
- Conversation message exchange: REST POST/GET — simple enough; no WebSocket needed initially
- LangGraph `interrupt()` is the mechanism for agent-initiated pause

WebSocket upgrade is a natural future extension when a real-time conversation UX is required.

## Conversation data model

```typescript
interface Conversation {
  id: UUID;
  company_id: UUID;
  role_name: string;
  task_id?: UUID;           // set if agent-initiated during a task step
  step_id?: UUID;
  status: 'awaiting_user' | 'awaiting_agent' | 'closed';
  created_at: Date;
  messages: ConversationMessage[];
}

interface ConversationMessage {
  id: UUID;
  conversation_id: UUID;
  author: 'user' | 'agent';
  content: string;
  timestamp: Date;
  teach?: 'memory' | 'knowledge';  // set by user to trigger teaching flow
}
```

## Consequences

- `Conversation` and `ConversationMessage` entities added to `src/models/`
- SSE endpoint added to lcp-server: `GET /tasks/{task_id}/audit/stream`
- Conversation CRUD endpoints added: `POST /conversations`, `GET /conversations/{id}`, `POST /conversations/{id}/reply`
- Auth guards (see [ADR-011](./ADR-011-authentication-authorization.md)) apply: `initiate_conversations` permission required to open a conversation

## Open Questions / Assumptions

- Notification mechanism: how does the user know an agent has paused and is awaiting input? Options: SSE push on the task stream, email, webhook. Defer to implementation — the data model supports all options.
- Conversation history in agent context: when resuming after a user reply, the full conversation history is injected into the agent's context, not just the latest message
