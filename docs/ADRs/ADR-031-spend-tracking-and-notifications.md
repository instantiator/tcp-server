# ADR-031: Spend Tracking and Notifications

**Status:** Implemented (2026-10-05) — delivered by 000.02

## Context

Nothing recorded token usage. `AGENT_ITERATIONS` caps how many turns an agent
loop can take, not what those turns cost. A company running a remote,
pay-as-you-go model could run up a bill with nothing to stop it, and nobody
would know until the invoice arrived.

The planning prompt asked for more than this ADR covers, and planning
narrowed it:

- **Company caps are dropped, application caps stay.** The prompt wanted a
  cap per company as well as per application, with a company cap optionally
  expressed as a percentage of the application cap. A home install usually
  has one company; splitting a shared provider budget across several only
  matters once that stops being true. [Outstanding issues](../outstanding-issues.md#company-spend-caps-and--shares)
  tracks it, with the condition that triggers building it.
- **No per-provider plan special-casing.** Consumer subscriptions (Claude
  Pro/Max, ChatGPT Plus, Gemini) can't be used through API keys, API keys are
  billed pay-as-you-go, and published plan limits change and aren't token
  counts. So the system takes whatever numbers the user enters; it doesn't
  try to know what a provider's plan allows.
- **A telemetry standard, without the dependency.** OpenTelemetry's GenAI
  semantic conventions define `gen_ai.usage.input_tokens` /
  `output_tokens`. They're still at "Development" status, so this work
  follows their field names without taking an OpenTelemetry dependency.

## Decision

Every LLM call's tokens are recorded, application-wide per-provider caps are
optional, and reaching one pauses agents (not chats) without losing their
work. Notifications tell the user what happened.

- **One recording hook.** Every LLM call already passes through one mapper in
  tcp-agent and one in tcp-server's chat path. Both now read the provider's
  reported token counts and attach them to the audit event they already
  write. A single `AuditService.write` hook inserts one usage row per call —
  see [Detail: recording](#detail-recording).
- **The unit is total tokens.** Input and output are still recorded
  separately, but a cap's limit is their sum. Tracking both separately would
  double every cap a user has to think about for no decision anyone actually
  makes differently.
- **Caps are configured per provider, at application level, in `.env`.** Each
  provider can have several limits (for example, a 5-hour stint and a weekly
  ceiling, imitating a subscription plan's rhythm), threshold
  notifications, and an action for when a limit is reached — see
  [Detail: configuration](#detail-configuration).
- **One enforcement point.** tcp-agent's loop checks the cap before every LLM
  call and before every context compaction call, at the same iteration
  boundary a shutdown drain already uses. Tripping the gate pauses the agent
  with its checkpoint intact and spends nothing further; a call already in
  flight still finishes, which is the one way a cap can be overshot — see
  [Detail: enforcement](#detail-enforcement).
- **An explicit start or resume is the user choosing to spend.** Starting a
  task while a cap is reached, or resuming one, exempts that task from caps
  until it ends, so it isn't paused again at its very next call. Resuming a
  company does the same for that company's paused tasks; it never lifts the
  cap for anyone else.
- **A reached cap resumes on its own when it resets.** A cap the user
  configured, not a system shutdown, is the one place auto-resume is right —
  a 5-hour stint cap that needed a human to un-pause it every 5 hours would
  be useless.
- **Notifications are application-wide, not per-company.** A threshold
  crossed, a cap reached, a cap resetting, and a provider reporting no usage
  each raise one notification, visible to every signed-in user and dismissed
  for everyone at once. They ride the SSE channel every company already has
  open, as a synthesized event — no new stream, no change to the connection
  budget ADR-025 set.
- **No pro-plan special-casing.** The user enters their own numbers; the
  system does not try to know what a provider's subscription allows. The
  documentation says plainly that a cap can be overshot by calls already in
  flight, and recommends also setting a hard spend limit in each provider's
  own console as the real backstop.

## Detail: recording

tcp-agent's stream mapper reads token counts off LangChain's
`usage_metadata` on `on_chat_model_end`, and context compaction
(`context-compactor.service.ts`) does the same for its own call. Both attach
`usage: { provider, model, inputTokens, outputTokens }` to the audit payload
they already write (`llm_response`, `compaction`). Chat, in tcp-server, goes
through the same mapper, so its tokens are recorded the same way — chats are
counted, just never gated.

`AuditService.write` calls `UsageService.record` for every audit event. Most
carry no `usage` and the call is a no-op. When one does, it inserts one row
into `token_usage` (`id, companyId, taskId?, agentId?, provider, model,
inputTokens, outputTokens, createdAt`) and nothing else — the table is
insert-only. A `GROUP BY taskId` gives per-task totals, and a cap check sums
`inputTokens + outputTokens` over a time window at read time, rather than
maintaining a running total anywhere. This avoids an upsert against a
nullable, composite key across two database engines (Postgres in production,
SQLite in tests), at the cost of a `SUM` over however many rows a window
holds — fine to roughly a million rows; see
[outstanding issues](../outstanding-issues.md#token_usage-rollup) for when to
add a rollup table instead.

A provider that reports no `usage_metadata` (its response carries no tokens
at all) is recorded as `untrackedProvider` instead, and raises one `warning`
notification the first time it happens, naming the provider. Its calls are
never counted and its cap, if any, can never be enforced — the documentation
says so. Embeddings and the model-compatibility probe are not counted either,
because LangChain's embeddings client exposes no usage figure to read; see
[outstanding issues](../outstanding-issues.md#embedding-and-model-check-usage-isnt-counted).

## Detail: configuration

`SPEND_CAPS` is a JSON object, validated by Joi at boot, keyed by a provider
id from the shared provider catalogue:

```json
{
  "anthropic": {
    "limits": [
      { "tokens": 2000000, "per": "5h" },
      { "tokens": 20000000, "per": "week" }
    ],
    "notifyAt": [50, 80],
    "action": "pause"
  }
}
```

- `per` is `month`, `week`, `day` (UTC calendar periods), or an `<N>h` stint
  that starts counting from the provider's first use after the previous
  stint ended — there is no provider API that reliably reports a
  subscription's own window, so this is the closest an operator can get to
  imitating one without the system guessing.
- `notifyAt` (default `[80]`) raises a `warning` notification at each listed
  percentage; reaching 100% always raises an `error`, whether or not 100 is
  listed.
- `action` (default `pause`) is one of three things a reached limit does:
  `pause` holds every further call back at the next iteration boundary;
  `finish-agents` lets an agent already running finish its current run, but
  holds back any agent that hasn't made its first LLM call; `finish-tasks` holds nothing back in the agent loop at all — it
  only switches the web UI's "start now" default to off, so the user decides
  task by task whether to keep going (004.01's scheduler will need to honour
  it the same way).
- Unset or empty, `SPEND_CAPS` defaults to no caps at all — a home install
  using only a local model never configures this and never trips it.
- Several `openai-compatible` endpoints share one catalogue id, so they share
  one cap; see
  [outstanding issues](../outstanding-issues.md#shared-cap-for-openai-compatible-endpoints).

A provider's live state — each window's start, whether it's currently
reached, and any dismissal — lives in one `spend_cap_state` row per provider,
the single table both tcp-server and tcp-agent read. tcp-server's
`SpendCapService` is the only writer, serialised per provider by an
in-process promise chain;
[outstanding issues](../outstanding-issues.md#single-tcp-server-instance-assumption-in-spendcapservice)
notes that this assumes one tcp-server instance.

## Detail: enforcement

The gate is one hook, read once per iteration before `checkBudget`, so a held
run spends nothing at all — not even on the compaction call that would
otherwise run first. It trips when all of these hold: the cap is reached and
not dismissed, the task isn't exempt, the run isn't a chat, and the reached
action's scope applies (`pause` always; `finish-agents` only before an
agent's first call of a fresh start). A tripped gate pauses the agent with
reason `spend_cap`, the same clean exit a shutdown drain uses, so its
LangGraph checkpoint is intact and it resumes exactly where it left off.

Resuming it is not quite the same as resuming a shutdown-paused agent,
though: a resume with no message is read as a fresh start, which would rebuild
the whole opening prompt. So a resume sends a short continuation prompt —
but only when the agent already has an `llm_response` row to continue from.
One held before its very first call has no checkpoint worth continuing, so it
restarts instead; sending it a continuation prompt pointing at a call that
never happened would confuse it, not help it.

Reaching a cap after a task is already running does not touch that task.
`POST /api/task/:id/start`, if any cap is reached at that moment, and the new
`POST /api/task/:id/resume` and `POST /api/company/:slug/resume`, mark the
task (or every task in the company) `spendCapExempt` before resuming its
agents — so the exemption is in place before the gate can see the resumed
agent again. The exemption lasts until the task ends; starting a new task
later checks the cap afresh.

A 60-second sweep, the same `setInterval(...).unref()` pattern used
elsewhere, clears any reached state whose window has ended and any
`until-reset` dismissal with it, then resumes every agent paused with reason
`spend_cap` — not `shutdown`, which only an explicit resume lifts. An agent
whose provider is still capped for some other reason simply pauses again at
its next check, spending nothing extra.

Admin-only endpoints
(`POST /api/spend/caps/:provider/dismiss`, `POST /api/spend/caps/:provider/restore`)
lift or restore a cap for every company at once, which is why they're
restricted — a non-administrator lifting one changes spend protection for
everyone, not just their own company.

## Alternatives considered

- **Company caps, and company caps as a percentage of an application cap.**
  This is what the prompt originally asked for. Dropped for now: a home
  install usually runs one company, so the extra configuration and the "a
  company's % cap is ignored without an application cap" warning case buy
  nothing until that stops being true. Recorded in
  [outstanding issues](../outstanding-issues.md#company-spend-caps-and--shares).
- **Separate input and output token limits.** Rejected: nobody asked for
  "500,000 input tokens and 100,000 output tokens" as two numbers to reason
  about; a single total is what a bill actually adds up to. Input and output
  are still recorded separately, so this remains available later without a
  schema change.
- **An upsert rollup table, updated on every usage row.** Considered instead
  of summing raw rows at read time. Rejected because it needs a composite,
  partially-nullable key (`provider` + `companyId` + `taskId` + window) to
  upsert against, which behaves differently on Postgres and SQLite — the two
  databases this project runs tests and production against. Summing at read
  time is simpler and fast enough until usage grows much larger; see
  [outstanding issues](../outstanding-issues.md#token_usage-rollup).
- **Pausing from tcp-server instead of inside the agent loop.** tcp-server
  would need to reach into a running loop to stop it cleanly, which is
  exactly the problem ADR-019's shutdown drain already solved the other way
  round — the loop checks its own state at an iteration boundary. Reusing
  that boundary needed no new mechanism.
- **A new, application-level SSE stream for notifications.** Rejected:
  every company channel is already open to any signed-in viewer of that
  company, and ADR-025 fixed the connection budget deliberately. A
  synthesized event on the existing channel reaches the same viewers for free.
- **Per-user notification dismissal.** Rejected as unnecessary complexity for
  what is, today, a single-admin, single-household system: one notification
  table, dismissed once, for everyone. 003.03 revisits this if push delivery
  needs it.

## Consequences

- Three new tables (`token_usage`, `notification`, `spend_cap_state`) and one
  new column (`tcp_task.spendCapExempt`), added in one migration and
  registered by hand in every `app.module.ts` that lists migrations, per the
  project's migration convention.
- A new `PauseReason`, `spend_cap`, alongside `shutdown` and the
  human-in-the-loop reasons `TcpAgent.pauseReason` already carried.
- A new `NotificationModule` and `SpendModule` in tcp-server, and a
  `SpendGateService` in tcp-agent.
- New CLI commands (`usage`, `notifications`, `dismiss-notification`,
  `dismiss-cap`, `restore-cap`, `resume-task`, `resume-company`) and new web
  surfaces (breadcrumb spend meters, a Notifications activity tab, toast
  wiring) — see [spend-caps.md](../spend-caps.md) for the operator-facing
  detail.
- Deferred, each with its own tracked condition in
  [outstanding-issues.md](../outstanding-issues.md): company caps and
  percentage shares; spend expressed in currency rather than tokens;
  embedding and model-check usage; an OTLP exporter (the field names already
  follow the GenAI conventions, so this is additive); a timezone setting for
  cap windows; the usage rollup table; splitting a cap across
  `openai-compatible` endpoints that currently share one; and the
  single-tcp-server-instance assumption in `SpendCapService`.
- Carried into later prompts, each noted in its own draft:
  000.04 (a Resume button in the task dialog), 003.03 (push delivery on the
  `notification` table), 004.01 (automatic task starts must honour
  `finish-tasks` and the gate), and 005.00 (per-task usage on the dashboard).

## Amendment as implemented (000.04, phase 04) <a id="amendment-as-implemented-p04-000-04"></a>

[000.04](../prompts/phase%2004%20-%20utility/000.04.01.plan%20-%20task%20controls%20and%20failure%20reasons%20in%20the%20web%20ui%20and%20cli.md) changed three things this ADR said. The mechanism for them is in [ADR-033](ADR-033-task-pause-failure-reasons-and-wait-reasons.md).

- **Resume exempts a task only while a cap is reached.** "Enforcement" above says `POST /api/task/:id/resume` and `POST /api/company/:slug/resume` mark the task `spendCapExempt` always. They now do it only if a cap is reached at that moment (`exemptIfCapped`), the same rule as Start. Resuming a user's own pause, with no cap reached, no longer switches off spend protection.
- **A company resume skips tasks a user paused.** `resumeCompany` leaves a manually paused task for its own `resumeTask`. The spend-cap sweep skips them too.
- **Task notices now exist beside spend notices.** Notifications gained a nullable `companyId` and `taskId`, and two kinds, `task_failed` and `task_paused`. "Notifications are application-wide" is no longer the whole story: a task notice belongs to its company, is listed by `GET /api/notifications/company/:companyId`, and is broadcast only on that company's channel. Dismissing one is open to the company's members and administrators only (404 for anyone else). Spend notices stay application-wide.
