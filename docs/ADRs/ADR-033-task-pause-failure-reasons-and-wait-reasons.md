# ADR-033: Task Pause, Failure Reasons and Wait Reasons

**Status:** Implemented (2026-10-09) — delivered by 000.04

## Context

A task could be started and cancelled, and nothing else. A user could not pause one, and when a task could not move it often said nothing. Three gaps stood out:

- **No manual pause.** The only pauses were the system's own: a reply being awaited, a consultation, a shutdown, a spend cap, a rate limit. A user who wanted to stop a task had to cancel it.
- **Resume lifted too much.** `resumeAgent` never checked why an agent was paused. A conversation reply or a consultation result therefore lifted _any_ pause. The reply was marked delivered, the agent ran again, and (for a spend-capped agent) stopped at the gate with the reply already used up. The reply was lost.
- **Failures were silent or raw.** A provider error was stored as the SDK's own text. A refusal showed as a bare status code. One task, started while LM Studio had no model loaded, neither started nor failed. Reproducing it found no hang in the connection. The real cause was a planner that sent the same refused plan five times, about two minutes a call, with nothing on screen to say so.

See [ADR-031](ADR-031-spend-tracking-and-notifications.md) and [ADR-032](ADR-032-model-concurrency-and-rate-limits.md) for the pause and resume mechanism this builds on, and [docs/tasks.md](../tasks.md) for the operator guide.

## Decision

A user can pause a task. Every resume names what it may lift. A failed run gets a plain reason from one typed table. A task that is standing still says why, in the same words on every surface.

### The manual pause

- **A soft stop, recorded on the task.** `POST /api/task/:id/pause` sets `TcpTask.pausedAt` and `pausedBy` in one conditional update, then pauses the task's agents with reason `manual`. It is allowed only while the task is `planning`, `in-progress` or `finalising` and not already paused. Otherwise it returns 409. `pausedBy` is the caller's name from the token.
- **Running agents stop at their next safe point.** That is the iteration boundary the shutdown drain and spend gate already use. No in-flight LLM call is killed, so a pause can take as long as the current call. The UI says so ("Pausing — agents stop after their current step").
- **The pause is on the task, not only on its agents.** The task is the one place that blocks every automatic resume, covers agents created while it is paused, and records who paused it.
- **Agents created while the task is paused start paused.** At the single enqueue point in `AgentOrchestrationService`, an agent whose task has `pausedAt` is written `paused` / `manual` instead of being queued.
- **The worker honours it.** `admit` drops a job whose agent is paused with `pausedAt` set. `run()` moves to `running` through a conditional `claimRunning`, which also refuses a live pause.
- **`failRun` spares a pause.** It does nothing to an agent that is `cancelled`, or `paused` with `manual`.

### Each resume names what it may lift

`resumeAgent` takes `ResumeOptions.lifts`: the pause reasons the caller may lift. A pause for any other reason is left alone, and the reply is not marked delivered.

| Caller                                       | Lifts                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------- |
| A reply, a consultation result, a QA verdict | `WAIT_REASONS`: `user_input`, `consultation` and none                       |
| The rate-limit sweep                         | `rate_limited`                                                              |
| The spend-cap sweep                          | `spend_cap`                                                                 |
| `POST /api/agent/resume/:id`                 | `ALL_REASONS`                                                               |
| `POST /api/task/:id/resume`                  | The explicit reasons, `manual`, and the waits whose reply arrived meanwhile |

- **A paused task refuses every resume except its own, with 409.** Only `resumeTask` clears `pausedAt` and passes `taskResume`. A reply that arrives meanwhile is kept, and is applied when the task resumes.
- **The lost-reply bug is fixed by this rule.** A reply can no longer wake an agent paused for a spend cap, so it is not spent early. `resumeAgent`'s outstanding-request count still keeps an agent paused if it is waiting on another answer.
- **The sweeps skip paused tasks.** Both query only tasks with no `pausedAt`, so they don't log a refusal every few seconds.
- **`resumeCompany` skips tasks a user paused.** Resuming a whole company should not undo one person's choice.
- **A manual resume continues, not restarts.** `pauseResumePrompt()` has a `manual` branch, used when the agent already has an `llm_response` row. An agent that never started restarts, which is right for it.

### Resume exempts a task from spend caps only while a cap is reached

[ADR-031](ADR-031-spend-tracking-and-notifications.md) said a resume always marked the task `spendCapExempt`. Resuming a user's own pause, with no cap in sight, would then quietly switch off spend protection for the rest of the task. `resumeTask` and `resumeCompany` now use `exemptIfCapped`, the rule Start already used: the exemption is set only if a cap is reached at that moment.

### Failure reasons

- **One typed table.** `RunFailureCode` is the extendable set, and `RUN_FAILURE_MESSAGES` is a `Record<RunFailureCode, …>`, so a new code does not compile until it has a message. Adding a reason is one code, one message and one test. It lives in `libs/tcp-shared/src/llm/run-failure.ts`.
- **The codes.**

| Group    | Codes                                                                                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider | `unreachable`, `llm_timeout`, `auth_rejected`, `forbidden`, `model_not_found`, `tools_unsupported`, `provider_error`                                                             |
| The run  | `no_llm_config`, `run_timed_out`, `iteration_limit`, `context_too_long`, `required_tools_missing`, `no_output`, `repeating_call`, `service_unavailable`, `stopped`, `unexpected` |

- **Each message says what went wrong and what to do.** The provider messages come from `classifyProbeError`, which moved from model-check into `libs/tcp-shared/src/llm/provider-error.ts`, so a run and a model check word the same error the same way.
- **A provider's own text is never echoed.** It may hold whatever answered at the address. It goes to the log only. An error this system raised itself keeps its own message as detail in `unexpected`, since that text is ours.
- **`service_unavailable` is recognised by marks the client libraries leave on an error.** These are the AWS SDK's `$metadata`, `McpError`, ioredis's `MaxRetriesPerRequestError`, and TypeORM's `QueryFailedError`. The message names the service.
- **The task says which part stopped.** The task's `failureReason` is the run's message with a plain prefix: "The planner stopped.", "Step N stopped.", "Finishing the task stopped.", "The review stopped before it finished." `recomputeTaskStatus`, which used to fail a task with no reason, now copies the failed step's reason.
- **The reason is stored in the existing `failureReason` column.** There is no code column.
- **The failure write cannot hide a failure.** If saving it throws, `failRun` logs the code and reason and still tells tcp-server, which fails the task.

### The repeating-call stop

An agent that makes the same tool call, with the same input, and gets the same result three times in a row (`MAX_CALL_REPEATS`) has its run aborted with `repeating_call`, before its next LLM call. A changed input or a different result resets the count.

The first design said "refused", not "same result". That was dropped. A refusal from a tool is relayed to the agent as an ordinary tool result, so the loop cannot reliably tell a refusal from an answer. "Same call, same result" can be checked without guessing, and it catches the real case (the planner resending a refused plan) as well as any other loop that makes no progress.

### The local model readiness check

For `local` and `custom` providers only, `checkModelReady` asks `GET {baseUrl}/models` (10 s timeout) before the run's first LLM call. No answer fails the run as `unreachable`. A model missing from the list fails it as `model_not_found`.

The check exists because LM Studio answers a request for an unlisted model with whichever model is loaded. A wrong model name would run silently on another model. LM Studio lists downloaded models whether or not they are loaded, so a listed but unloaded model passes and loads on first use.

- Remote providers are skipped. Their lists can omit what they serve, such as Azure deployments.
- An answer that does not settle it (an error status, a body that is not a model list) lets the run go ahead, so the real call's own error is what gets reported.
- `LLM_READINESS_CHECK` turns it off. It defaults to true, and compose passes `${LLM_READINESS_CHECK:-true}`. It is also off when config is stubbed, so test modules never reach a real server.
- LangChain's retries stay at their default. A refused connection fails in about a minute on its own, and the check catches it within 10 s. The 30 minute generation timeout stays too: it is right for generating, and wrong only for finding the model.

### Wait reasons

`taskWaiting(task, agents)` in `libs/tcp-shared/src/tasks/task-waiting.ts` works out why a task is standing still: `{ kind, pausedBy?, resumeAfter? }`, or `null`. It is runtime-free and exported from `client.ts`, so the server, the web client and the CLI use one function and say the same thing.

- **Precedence.** The task's own pause (`manual`) first. Then the agents' reasons: `rate_limited`, `spend_cap`, `shutdown`, `manual`, `user_input`, `consultation`. Then `queued`, if an agent is waiting for a model slot.
- **`GET /api/task/:id` returns `waiting`.** The CLI's `get-task` shows it. The web dialog computes it from live data.
- **Text maps are typed as `Record`s.** `PAUSE_REASON_TEXT: Record<PauseReason, string>` in the shared transcript, and one string key per reason in the web client. A new pause reason fails to compile until it has words.

### Task notifications, scoped to their company

`task_failed` and `task_paused` notifications are raised by `TaskStateService.failTask` (and a recompute to failed), and by the shutdown drain (one per task). A manual pause raises none (the user did it), and a spend-cap pause raises none (`spend_reached` covers it). Raising one is wrapped, so a notice that cannot be saved never undoes the failure or stops the drain.

Notifications gained a nullable `companyId` and `taskId`. The original plan was an optional `companyId` filter on the global list. That was rejected: the membership guard decides access from the route, and a query filter on an unguarded route cannot express "only this company's rows". The built design:

- **`GET /api/notifications` returns only application-wide rows.**
- **`GET /api/notifications/company/:companyId` is `@CompanyScope`** and returns the application-wide rows plus that company's. The guard does the check, like every other company route.
- **Dismissing a company's notice is checked in the handler.** The route names no company, so the guard cannot. A caller who is neither a member nor an administrator gets 404, not 403: the notice does not exist for them, so its id says nothing about its content.
- **A company's notice is broadcast on its own company channel only.**

## Alternatives considered

- **Killing the in-flight call on pause.** It would make a pause instant. Rejected: there is no abort signal in the run today (cancel is database-only), so adding one is a larger lifecycle change. A killed call is also spend with nothing saved. The soft stop reuses the boundary shutdown and spend caps already trust, and its cost is only a wait of up to one call.
- **A task-level `paused` status.** Rejected: `deriveTaskStatus` derives a task's status from its assignments, and every surface and filter reads the existing seven values. A flag (`pausedAt`) records the pause without a new state to handle everywhere, and a task keeps its real status while paused.
- **A failure code column.** Rejected: the message is what users read, and it is already in `failureReason`. A second column would need a migration and nothing consumes it. The typed table keeps the codes in code, where a missing message fails to compile.
- **"Refused call" for the repeat stop.** See [the repeating-call stop](#the-repeating-call-stop).
- **Letting the provider's text through.** Rejected: it can hold whatever answered at the address, and it is not actionable. The classified message is.
- **An optional `companyId` filter on the global notification route.** See [task notifications](#task-notifications-scoped-to-their-company).
- **Retrying a failed task.** Left out. A failed task's message says what to fix, then the user starts again. A retry endpoint is new scope; see [outstanding-issues.md](../outstanding-issues.md).

## Consequences

- Three new `TcpTask` columns, `pausedAt`, `pausedBy` and `visualisationClosedAt` (the last is for the office view's closed rooms; see [web-client.md](../web-client.md)), and two new nullable `Notification` columns, `companyId` and `taskId`. Both migrations are registered by hand in the migrations list.
- New `PauseReason` `manual`, and new `NotificationKind`s `task_failed` and `task_paused`.
- New routes: `POST /api/task/:id/pause`, `POST /api/task/:id/close-visualisation`, and `GET /api/notifications/company/:companyId`. The CLI gained `pause-task`.
- `TaskControlService` holds the two user controls (pause and close).
- `failureReason` wording changed everywhere. Tests that asserted the old strings were updated to the new wording.
- Every new `PauseReason` needs a branch in `pauseResumePrompt()`, a line in `PAUSE_REASON_TEXT`, a string key in the web client, and a place in `taskWaiting`'s precedence. The first two fail to compile if missed.
- Deferred, each with its own tracked condition in [outstanding-issues.md](../outstanding-issues.md): supporting services fail a task rather than pause it; no retry for a failed task; a stranded `running` agent when the failure write itself fails; an MCP server that is down at tool-load time is skipped quietly; no CLI `close-room`; the chat `sendMessage` has no pause guard; failed or cancelled rooms get no marker; the task dialog's live agent data comes from the company stream; `UpdateTaskDto` cannot clear a planner; the TUI has no pause or resume keys.
- See [ADR-026](ADR-026-web-ui-accessibility-and-component-library.md#amendment-as-implemented-p04-000-04) and [ADR-031](ADR-031-spend-tracking-and-notifications.md#amendment-as-implemented-p04-000-04) for the amendments this work made.
