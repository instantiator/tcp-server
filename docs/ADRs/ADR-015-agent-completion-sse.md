# ADR-015: Agent Completion via SSE Instead of Long-Poll

**Status:** Proposed

## Context

When a chat agent calls `request_agent_consultation` or `request_user_input`,
the agent pauses mid-turn and its BullMQ job exits. The real answer arrives
later — after the called agent (or the user) responds and the original agent
resumes as a new BullMQ job.

The current implementation (introduced alongside ADR-012) bridges this gap
with a Redis pub/sub long-poll: `chat.service` holds the HTTP connection open,
subscribes to `agent:completed:{agentId}` on Redis, and returns only when
`AgentLoopService` publishes the final response. This works, but has three
weaknesses:

1. **Held connections.** A single consultation can span several minutes of LLM
   processing. The HTTP connection is occupied for the entire duration.
2. **No reconnect resilience.** If the client or an intervening proxy drops
   the connection (timeout, network blip), the response is lost. There is no
   way to recover it without starting over.
3. **Composition.** Holding a single HTTP connection per agent makes it
   awkward to support future features that naturally fan out — e.g. watching
   multiple agents from one UI, or streaming incremental tool-call progress
   alongside the final answer.

## Decision

Replace the long-poll with an SSE-based completion flow:

1. **`POST /api/agent/:id/message` returns `202 Accepted` immediately** when
   a pause is detected, rather than blocking. The response body includes
   `{ pending: true }` so the client knows to expect the answer on the SSE
   stream.

2. **`GET /api/agent/:id/events` (already exists) emits a `completed` event**
   carrying `{ response: string }` when the agent's resumed run finishes.
   `AgentEventService` in lcp-server subscribes to `agent:completed:{agentId}`
   on Redis (the channel already published to by `AgentLoopService`) and
   forwards the payload to any connected SSE clients.

3. **`lcp-cli chat` waits on the SSE stream after a `202` response.** The
   existing `observeEvents` helper already opens the event stream; it is
   extended to watch for `completed` and print the response text. The user
   sees no change in the interface — the response appears in the terminal when
   it arrives, exactly as today, just without a dedicated HTTP connection.

4. **`LcpAgent.completionMessage` column added.** The final response text is
   persisted on the agent record before publishing to Redis. A client that
   missed the SSE event (reconnected late, network blip) can recover by
   polling `GET /api/agent/:id` and reading `completionMessage` directly.
   `AgentEventService` also checks this field when a new SSE subscriber
   connects mid-run, so a reconnect after the event has already fired still
   delivers the answer.

The internal Redis pub/sub channel (`agent:completed:{agentId}`) is unchanged
— it remains the bridge between lcp-agent and lcp-server. What changes is the
external surface: a non-blocking `202` plus SSE rather than a blocked `200`.

## Alternatives considered

- **Keep the long-poll, raise the timeout.** Avoids any client change but
  does not fix the resilience or composition problems. Ruled out.

- **Client-side polling (`GET /api/agent/:id` on an interval).** Simple to
  implement and always recoverable from the stored `completionMessage`. Chosen
  as the recovery path (see point 4 above) but not as the primary path —
  polling burns requests and adds latency equal to the poll interval.

- **WebSockets.** Full-duplex and the most capable option long-term. Deferred
  per ADR-012 — SSE covers this use case with less infrastructure complexity.
  WebSocket upgrade remains the natural future extension when real-time
  two-way conversation UX is needed.

## Consequences

- `POST /api/agent/:id/message` gains a `202` response path. Non-pausing
  turns continue to return `200` synchronously — no change for callers that
  don't trigger a consultation or user-input pause.
- `GET /api/agent/:id/events` emits a new `completed` event type. Existing
  consumers (compaction progress reporting) are unaffected.
- `LcpAgent` gains a `completionMessage` column — requires a migration.
- `lcp-cli chat` is updated to handle `202` responses and wait on the SSE
  stream. The 35-minute client-side timeout on the SSE stream replaces the
  same timeout currently on the long-polled POST.
- `AgentEventService` gains a Redis subscriber for the
  `agent:completed:{agentId}` channel. The subscription is created when the
  first SSE client connects and torn down when the last one disconnects,
  following the existing `AgentEventService` lifecycle pattern.
- The long-poll path in `chat.service.ts` (`waitForAgentCompletion`) is
  removed. The Redis subscriber moves from `chat.service` into
  `AgentEventService` — one subscriber per agent regardless of how many SSE
  clients are connected.
