# ADR-019: The API Drains, the Host Halts

**Status:** Accepted (2026-07-28)

## Context

Stopping the simulation used to mean stopping containers — `./scripts/stop-dev.sh`,
or `docker compose down`. That is abrupt in a way that costs real money: an agent
part-way through an LLM call loses the tokens already spent on it, and its task is
left mid-flight for startup recovery to sort out.

We wanted two modes:

- **Graceful** — suspend the shutdown until every running agent has reached a
  resumable point, so no in-flight LLM call is thrown away.
- **Forced** — stop the LLM work immediately and accept the waste.

Three facts about the existing system shaped the design:

1. **Every Compose service is `restart: unless-stopped`.** A process that calls
   `process.exit()` is restarted by Docker seconds later. In-process suicide
   achieves a bounce, not a halt.
2. **The agent loop already has a resumable point.** `runSupervisedGraph` calls
   `checkTerminalStatus()` at every tool-loop iteration boundary, and the graph is
   compiled with `interruptAfterTools: true`. An agent whose row reads `paused`
   exits cleanly at its next boundary with its LangGraph checkpoint intact. This
   is exactly "after the LLM next responds".
3. **Nothing calls into tcp-agent.** Dispatch is one-way over BullMQ, and the MCP
   servers call _into_ tcp-server. tcp-agent publishes to Redis but subscribes to
   nothing.

## Decision

**tcp-server owns draining; the host wrapper owns halting.**

`POST /api/system/shutdown` marks the system draining and brings agents to rest.
It never stops a process. `tcp-cli.sh` runs `docker compose stop` once the API
reports the system quiesced — halting is a host-side action, so it lives in the
host-side script. Draining works identically without Docker (a bare
`npm run start:dev`); the operator just stops the process themselves.

### Quiescence is confirmed by the worker, not inferred from the database

The drain marks each `Running` agent `Paused`. That is a _request_ to stop, not
evidence of one: the agent is still mid-LLM-call, and the paused row is
tcp-server's own write. Reading it back and declaring success would report a
finished shutdown while an agent was still burning tokens.

So tcp-agent reports its real in-memory count of running loops — the size of
`AgentRegistryService` — back over Redis, and the drain only quiesces when that
count reaches zero. A drain that marked no agents needs no confirmation and
quiesces on the database count alone, so a stack with no tcp-agent deployed still
shuts down cleanly.

### Redis pub/sub carries the commands

Two channels, defined in `@tcp/shared` (`events/shutdown-channel.ts`):

- `tcp:shutdown:command` — tcp-server → workers: `drain`, `force`, or `cancel`.
- `tcp:shutdown:status` — workers → tcp-server: `{ activeAgents }`.

Redis is the one transport both processes already share. An internal HTTP
endpoint on tcp-agent would have needed a new service-to-service URL in every
deployment shape, and would have inverted a dependency direction that currently
only points one way.

### A pause reason, not a new status

`AgentStatus.Paused` already meant "waiting for user input or a consultation",
and `resumeAgent` gates on there being no outstanding requests — which a
shutdown-paused agent, having none, would sail straight through. A nullable
`TcpAgent.pauseReason` column (`user_input` | `consultation` | `shutdown`)
distinguishes them. A new `AgentStatus` value would have forced updates to every
exhaustive status check across the server, agent, CLI renderers and TUI for no
extra capability.

### Shutdown state is not persisted; paused agents are

The draining flag lives in memory and resets to `idle` on boot, so a restarted
stack always comes back accepting work. Agents the drain paused stay paused, and
are resumed explicitly by a user — auto-resuming on boot would start burning
tokens the moment anyone runs `docker compose up`, which is the opposite of what
this feature is for.

## Alternatives considered

- **Process suicide on SIGTERM.** The obvious reading of "the services halt", and
  wrong here: the restart policy would bring them straight back. Ruled out.

- **Derive quiescence from agent status in the database.** No new channel, and
  tcp-server already owns the data — but it can only ever tell you what the drain
  asked for, not what happened. It would report success mid-LLM-call. Ruled out;
  this is the whole correctness question the feature turns on.

- **A new `AgentStatus.Draining`.** Rejected above: large blast radius, no gain
  over a reason column, and the CLI gets nothing useful to display either way.

- **`worker.close(true)` for the forced path.** BullMQ's forced close is the
  documented counterpart to the graceful one, but it abandons jobs mid-write and
  cannot be undone, so a cancelled drain could never hand the worker back. Forced
  mode uses `worker.pause()` plus the registry's `AbortController`s instead —
  more precise about what it stops, and reversible.

## Consequences

- A new fleet-level surface: `POST`/`GET`/`DELETE /api/system/shutdown`. It is the
  first endpoint family that acts on the whole simulation rather than one agent or
  task, and it is `JwtAuthGuard`-protected like any other user-facing route.
- While draining, `POST /api/agent/start`, `POST /api/agent/chat/start` and
  `POST /api/task/:id/start` return **503**, and `AgentOrchestrationService` stops
  enqueueing jobs — including resumes. A drain that kept handing work to the
  workers it is waiting on would never finish.
- `TcpAgent` gains a `pauseReason` column, so a migration
  (`AgentPauseReason1784810000000`).
- Resuming a shutdown-paused agent injects a short continuation message. Without
  it, tcp-agent treats a resume carrying no content as a fresh run and rebuilds
  the entire opening prompt on top of the checkpoint it should be continuing from.
- A forced abort no longer fails the run: `AgentRunStatusService.failRun` leaves a
  shutdown-paused agent paused, because recording it as `Failed` would bury the
  reason it stopped and lose the pause the operator is meant to resume from.
- `TaskRecoveryService` needed **no change** — it already leaves `Running`/`Paused`
  agents alone, and `selectNextAssignments` returns nothing while an assignment is
  `in-progress`, so startup reconciliation neither fails nor re-dispatches a task
  whose agent is shutdown-paused.
- `--force` wastes the tokens spent on whatever calls were in flight. That is the
  documented trade-off, and the CLI says so at the point of use.
- Single deployment only. The worker's status reports are not keyed by worker id,
  so several tcp-agent instances would overwrite each other's counts; a
  multi-instance deployment needs a per-worker tally first.

## Amendment as implemented (000.05, phase 04) <a id="amendment-as-implemented-p04-000-05"></a>

[000.05](../prompts/phase%2004%20-%20utility/000.05.01.plan%20-%20system%20menu%20for%20health%20and%20shutdown.md) changed three things this ADR said. The mechanism is in [ADR-034](ADR-034-restart-and-startup-recovery.md).

- **A restart may exit the process.** "Process suicide" is still ruled out for a _halt_. A restart drain (`?restart`) ends with tcp-server and tcp-agent exiting so Docker starts them again, but only where `TCP_RESTART_SUPPORTED` says something will. Agents a restart pauses carry the reason `restart`, and the next boot resumes them by itself.
- **`TaskRecoveryService` changed.** "Needed no change" no longer holds. Startup recovery now resumes `running` or `queued` agents that have no job, from their checkpoint, and fails one only if its task has ended or it was recovered once before. It also repairs tasks stuck in `finalising`. A `shutdown` pause is still left for a user to resume.
- **Draining has a web surface.** The System menu's shutdown dialog drains, restarts and cancels, but never halts: the host still stops the services. Every signed-in user sees a banner while the system is shutting down or restarting (`GET /api/system/status`). Resuming a drained task is `POST /api/task/:id/resume` or `resume-company`, not one agent at a time.
