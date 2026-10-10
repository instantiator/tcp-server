# ADR-034: Restart Drains, Then Bounces; Startup Recovery Repairs Before It Fails

**Status:** Implemented (2026-10-10) — delivered by 000.05

## Context

[ADR-019](ADR-019-graceful-shutdown.md) gave the system a graceful shutdown: the API drains, and the host halts. 000.05 adds a system menu in the web client, and three gaps showed up beside it:

- **No restart.** Picking up new configuration, or clearing a stuck process, meant a shutdown from the CLI, `docker compose stop`, a start, and then resuming every paused task by hand.
- **Nothing repaired an agent left `running`.** A crash, or a failure whose own write failed (000.04), left an agent `running` or `queued` with no job behind it. `TaskRecoveryService` deliberately left `Running` agents alone, so its task sat still forever.
- **Tasks stuck in `finalising` were never repaired.** The startup query selected only `planning` and `in-progress` tasks, so `reconcileFinalising` could not run.

## Decision

### A restart is a drain, then a bounce

`POST /api/system/shutdown?restart` (and `tcp-cli restart`, and the web dialog's **Restart**) drains exactly as a shutdown does, with one difference: running agents are paused with a new reason, `restart`, not `shutdown`. Once the drain quiesces, tcp-server publishes `restart` on the shutdown command channel and then sends itself `SIGTERM` (after one second, so the reply and the publish go out first). tcp-agent does the same when it hears `restart`. Nest's shutdown hooks close each process cleanly, and Docker's `restart: unless-stopped` starts both again.

ADR-019 ruled out a process exiting itself, because the restart policy brings it straight back. That is exactly the wrong behaviour for a halt, and exactly the right one for a restart.

- **Only where something restarts the process.** `TCP_RESTART_SUPPORTED` (default `false`) is set to `true` for tcp-server and tcp-agent in `docker-compose.yml`. Without it, a restart request is refused with 409, since it would just be a stop. A tcp-agent without the flag resumes its worker instead of exiting. The test tiers never set it, and the exit itself is injectable (`ProcessRestarter`), so a test can never end its own runner.
- **A drain can't change kind.** A restart request during a plain shutdown, or the reverse, gets 409: the agents already paused carry the other kind's reason. `force` may still escalate either.
- **The restart pause lifts itself.** Tasks that were running get an `info` notice ("…carries on by itself once the system is back"). The next boot resumes every `restart` pause. A user can still resume one by hand (`restart` is in `EXPLICITLY_RESUMABLE`) if the restart never came back. A task a user paused stays paused.

### Startup recovery repairs before it fails

On boot, before the task pass, `AgentRecoveryService`:

1. **Finds stranded agents:** `running` or `queued`, with no BullMQ job (active, waiting, delayed, prioritized, or waiting-children). If the queue can't be read, it touches nothing. It never fails an agent for want of seeing its job.
2. **Pauses each one for a restart**, through a conditional update on its current status, and audits the change with `recovered: true`. It fails the agent instead, with the run-failure code `interrupted` ("This step stopped unexpectedly and couldn't be carried on. Start the task again."), if its task or step has already ended, or if an earlier boot already recovered it. The second rule stops an agent that strands itself every time from being resumed on every boot.
3. **Resumes every `restart` pause**, from a restart drain or from step 2. The run carries on from its LangGraph checkpoint, with a short continuation message. An agent that never reached its first LLM call starts afresh instead.

Recovery then runs the existing task pass, which now includes `finalising`. A finalise step that succeeded, but whose task was never marked, finishes the task. A missing finalise step is dispatched. A finalise agent that really failed fails the task, as before.

Recovery runs in `onApplicationBootstrap`, so the agent queue is connected before it is read.

## Alternatives considered

- **Fail every stranded agent.** This was the first plan. It is simpler, but a restart would then have needed its own resume path, and a crash would fail work that could have carried on. With one "pause, then resume" path, a restart and a crash recover the same way.
- **Persist a "restart pending" flag in Redis**, rather than a pause reason. The agent row already holds the pause; a second record could drift from it.
- **Restart the containers from the host wrapper**, as halting is done. A web page has no host wrapper, and the browser was the main reason for adding restart.
- **A per-agent recovery counter column.** The audit `state_change` already records the recovery, so the crash-loop rule needs no migration.

## Consequences

- `PauseReason` gains `restart`. Every table keyed by it gained an entry: resume prompts, lift lists, wait precedence and text, the web strings, and the failure-write skip list.
- `ShutdownStatus` gains `restart` and `restartSupported`. `GET /api/system/status` (for every signed-in user) exposes `{ admin, shutdown: { state, restart } }`, which drives the web client's System menu and its shutdown banner.
- Recovery runs only when tcp-server boots. If tcp-agent restarts while tcp-server stays up, the agents it strands are left to BullMQ's stall handling. Running step 1 on a timer would close that gap, and `docs/outstanding-issues.md` records when to do it.
- A non-Docker deployment can't restart from the API. It shuts down and is started by hand, as before.
