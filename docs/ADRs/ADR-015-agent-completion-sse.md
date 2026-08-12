# ADR-015: Agent Completion via SSE Instead of Long-Poll

**Status:** Accepted (amended 2026-07-02 — see "Amendments as implemented")

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
   `AgentEventService` in tcp-server subscribes to `agent:completed:{agentId}`
   on Redis (the channel already published to by `AgentLoopService`) and
   forwards the payload to any connected SSE clients.

3. **`tcp-cli chat` waits on the SSE stream after a `202` response.** The
   existing `observeEvents` helper already opens the event stream; it is
   extended to watch for `completed` and print the response text. The user
   sees no change in the interface — the response appears in the terminal when
   it arrives, exactly as today, just without a dedicated HTTP connection.

4. **`TcpAgent.completionMessage` column added.** The final response text is
   persisted on the agent record before publishing to Redis. A client that
   missed the SSE event (reconnected late, network blip) can recover by
   polling `GET /api/agent/:id` and reading `completionMessage` directly.
   `AgentEventService` also checks this field when a new SSE subscriber
   connects mid-run, so a reconnect after the event has already fired still
   delivers the answer.

The internal Redis pub/sub channel (`agent:completed:{agentId}`) is unchanged
— it remains the bridge between tcp-agent and tcp-server. What changes is the
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
- `TcpAgent` gains a `completionMessage` column — requires a migration.
- `tcp-cli chat` is updated to handle `202` responses and wait on the SSE
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

<a id="amendments-as-implemented-0084"></a>

## Amendments as implemented (008.4)

The proposal above was implemented with the following changes, driven by the
008.4 streamed-chat work (full live observability, not just completion):

1. **`POST /api/agent/:id/message` returns `202` on _every_ turn**, not only
   when a pause is detected. The turn runs detached (`ChatService.runTurn`) and
   the entire turn — status transitions, LLM activity, token-by-token reasoning
   and response deltas, and the terminal `completed`/`failed` event — streams
   over `GET /api/agent/:id/events`. There is no synchronous `200` body; the
   long-poll is gone entirely.

2. **No `completionMessage` column.** The existing `TcpAgent.output` column
   (already written before completion is signalled) plus `status` is the
   recovery source. A client that missed the SSE `completed` event recovers via
   `GET /api/agent/:id`; the SSE endpoint additionally **synthesises** a
   terminal event from `output`+`status` for clients that subscribe after the
   turn has already finished (`AgentController.replayTerminal`). No migration.

3. **Event vocabulary is shared** in `@tcp/shared` (`events/agent-events.ts`) as
   a single `AgentEvent` union used by tcp-server, tcp-agent, and tcp-cli:
   `agent_status`, `llm`, `reasoning`, `response`, `consultation_started`,
   `completed`, `failed`, and the existing `compaction_*` kinds.

4. **The `agent:completed:{agentId}` Redis channel is retired.** tcp-agent now
   publishes observability events (LLM/tool activity, reasoning/response deltas,
   worker status transitions) to `agent:events:{agentId}` via a persistent
   publisher connection; `AgentEventService` lazily subscribes (reference-counted
   per agent over one shared connection) and relays them onto the in-memory
   Subject. **Terminal `completed`/`failed` events originate in tcp-server**
   (`PauseAndResumeService.completeAgent`/`failAgent` for worker-run agents;
   `ChatService.runTurn` for in-process chat turns), so `publishCompletion` is
   deleted.

5. **Consultation follow.** When an agent pauses to consult another, the caller's
   stream emits `consultation_started { agentId, roleName }`; `tcp-cli chat`
   opens an additional (recursively nested) event stream for the consulted agent
   and renders its lines prefixed with the consulted role's name.

**Note:** after a consultation cycle the chat agent may rest at `Completed`
rather than `Idle` (the old `Idle` reset lived in the deleted long-poll
`finally`). This is harmless — `sendMessage` does not gate on status, and the
recovery poll treats `Completed`-with-output as a finished turn.

<a id="amendments-as-implemented-01032"></a>

## Amendments as implemented (010.3.2)

_2026-07-16._ Two new streams follow the same shape, so the TUI's company
task list and task/assignment panels can live-update without polling:

- **`GET /api/company/:id/events`** (`CompanyController.streamCompanyEvents`)
  — `CompanyEvent` union (`company_changed`, `task_changed`), on the
  `company:events:{companyId}` channel.
- **`GET /api/task/:id/events`** (`TaskController.streamTaskEvents`) —
  `TaskEvent` union (`task_changed`, `assignment_changed`), on the
  `task:events:{taskId}` channel.
- Both event unions and channel helpers live in `libs/tcp-shared/src/events/`
  (`company-events.ts`, `task-events.ts`), alongside the existing
  `agent-events.ts`. A shared `TaskChangeSummary` (id, status, request,
  timestamps, `completedSteps`/`totalSteps` from the implement-mode plan) is
  the payload for every `task_changed` event and the priming snapshot — the
  same shape a task-list row renders from, so the CLI never needs a refetch.
- Both endpoints **prime** the stream with the current state before merging
  in live events (`defer` + `merge`, the same pattern `AgentController`'s
  `replayTerminal` uses) — the company stream primes with `company_changed` +
  every current task's `task_changed`; the task stream primes with its own
  `task_changed` + every current assignment's `assignment_changed`.
- **One architectural difference from the agent bus**: every producer of
  company/task events runs in-process within tcp-server (task/assignment
  state changes always funnel through `TaskOrchestrationService`, itself
  triggered by an HTTP call even when tcp-agent is the ultimate cause) — there
  is no separate out-of-process publisher analogous to tcp-agent's
  `AgentEventPublisherService`. So the new `KeyedEventBus` (generic base
  shared by `CompanyEventService`/`TaskEventService`, `apps/tcp-server/src/
events/keyed-event-bus.ts`) folds emit and relay into one class: `emit`
  publishes to Redis and lets the channel subscription deliver the event back
  to local observers (rather than pushing to the local `Subject` directly),
  which avoids double-delivery on an instance that both emits and observes
  the same key. When `REDIS_URL` is unset, `emit` falls back to a direct local
  push (pure in-memory — the default in unit tests).
- **Emit points**: `TaskOrchestrationService.recordTaskState`/
  `recordAssignmentState` are the single place every task/assignment
  transition is recorded (audit) and emitted (SSE) — including the
  previously-unaudited `ready → planning` transition on task start, now
  recorded/emitted from `dispatchPlanner`. Regression fixed along the way:
  `acceptAssignment`/`rejectAssignment` claimed the new status atomically in
  the DB but never updated the in-memory assignment object before calling
  `recordAssignmentState`, so both the audit payload and (now) the SSE
  payload would have reported the stale prior status (`in-qa`) instead of the
  real new one (`succeeded`/`failed`/`in-progress`).
- A company entity update (`ApiService.setCompany`) emits `company_changed`.

---

<a id="amendments-as-implemented-002041"></a>

## Amendments as implemented (002.04.01)

`GET /api/company/:id/events` now carries **five** `payload.entity` kinds —
`company`, `task`, `agent`, `assignment` and `enquiry` — rather than the
company and task rows described above, and is primed with one row per current
task, active agent, open consultation and open enquiry. See the
[002.04.01 amendment to ADR-023](ADR-023-backend-api-surface-for-the-web-ui.md#amendments-as-implemented-002041)
for why, including the `entity: 'enquiry'` rows that did not previously exist.
