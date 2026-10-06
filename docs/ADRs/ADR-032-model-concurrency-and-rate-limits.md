# ADR-032: Model Concurrency and Rate Limits

**Status:** Implemented (2026-10-06) — delivered by 000.03

## Context

A home install usually has one GPU. Before this, every agent run shared one
global concurrency limit, `AGENT_WORKER_CONCURRENCY` (default 1), so two
tasks never actually ran their agents in parallel — a second agent just
queued, invisibly, inside the worker pool, and a wait looked like a hang. A
remote provider can do far more work in parallel, but letting agents fan out
with no cap also means an unbounded spend rate.

Separately, a provider refusing a call with HTTP 429 failed the run outright.
LangChain's own retry layer already retries a short-hinted 429 (60 s or
less) itself, honouring `Retry-After`; everything else — a longer hint, no
hint at all, or a quota/credit refusal — threw straight through to
`failRun`. A reached rate limit or exhausted quota should pause an agent the
way a spend cap already does (ADR-031), not fail its run.

See [docs/llm-rate-limits.md](../llm-rate-limits.md) for the per-provider
research this decision is built on, and
[ADR-031](ADR-031-spend-tracking-and-notifications.md) for the pause/resume
mechanism it reuses.

## Decision

Agent runs are limited by two global pools instead of one flat worker
concurrency, and a rate limit pauses an agent instead of failing it.

- **Two pools, `local` and `remote`, replace `AGENT_WORKER_CONCURRENCY`.**
  Every agent run counts against whichever pool its provider's catalogue
  `kind` belongs to (`custom` counts as `local` — it's still someone's own
  server, not a metered account). Defaults ship set (`local: 1`, `remote: 4`)
  so a fresh install behaves sensibly with no configuration; an operator can
  raise either or clear it to `null` for unlimited. One number protects a
  single GPU's performance and the other limits how fast a paid provider can
  be spent against, with no per-model configuration needed.
- **Optional per-endpoint limits sit on top of the pools.**
  `MODEL_CONCURRENCY.endpoints` names one extra limit for one endpoint — for
  example two local servers sharing the `local` pool, or a provider whose own
  rate limit is lower than the `remote` default. An agent starts only when
  both its pool and, if one is set, its endpoint have room; an unset endpoint
  limit constrains nothing.
  - **Endpoint key.** A remote provider is keyed by its catalogue provider
    id, because rate limits and spend are per account, not per URL. A local
    or custom provider is keyed by its normalised base URL (lower-cased,
    trailing slash stripped), because one server is one GPU whatever model it
    serves, and a provider id would conflate two different local servers.
- **Limits apply per agent run, not per LLM call.** "Can this agent start" is
  the question, not "can this call go out" — a run makes one LLM call at a
  time anyway. A paused agent's job ends, so it frees its slot immediately
  rather than holding it for the whole pause.
- **A reached limit queues the job in BullMQ** rather than blocking a worker
  thread or failing the run — see [Detail: mechanism](#detail-mechanism).
- **A rate limit pauses the agent (`rate_limited`), with auto-resume**, the
  same shape ADR-031 gave spend caps — see
  [Detail: rate limits](#detail-rate-limits).
- **A new `queued` agent status** shows "waiting for a model" distinctly from
  "paused" or "running", set both when tcp-server dispatches the job and when
  the worker defers it, so a wait is visible immediately on dispatch, not
  only once the worker runs and discovers its pool is full.

## Detail: mechanism

`ModelSlotService` (tcp-agent, in-memory) holds one counter per pool and per
endpoint, plus a FIFO of waiting job ids per pool. `tryAcquire` checks the
pool and the endpoint counters and takes both or neither, with no `await`
between the check and the take — tcp-agent is already assumed to run as a
single instance (see Consequences). BullMQ's own worker `concurrency` becomes
a fixed ceiling of 100 (`// ponytail:`, since BullMQ needs some number) — it
no longer does any limiting itself; `ModelSlotService` is the only gate.

A job refused a slot is moved to BullMQ's delayed set with
`job.moveToDelayed()`, and the processor throws BullMQ's `DelayedError` — the
documented way to hand a job back without marking it failed or retried. It is
promoted back out of the delayed set as soon as a slot frees (`release()`
returns the oldest waiter in that pool that now fits; the worker calls
`Job.fromId(...).promote()`), with a 30 s fallback recheck in case a
promotion is ever missed — for example, the waiter was deferred by a process
that has since restarted. A deferred job holds no pool or endpoint slot while
it waits.

A stale job — one whose agent has already reached `completed` or `cancelled`
— is dropped rather than admitted, so a long wait can't let a late-arriving
job overwrite a terminal status with `running`.

Chosen over:

- **BullMQ Pro's group concurrency**, which solves exactly this shape of
  problem but is a paid product; this project runs on the free tier.
- **A separate BullMQ queue per endpoint**, which would need a queue created
  and torn down per dynamically-configured `llmConfig` rather than one fixed,
  well-understood `agent-jobs` queue — more moving parts for the same result.
- **A semaphore per LLM call** instead of per run, rejected because it only
  works if an agent never holds its slot between calls — see the per-run
  decision above.

## Detail: `queued` status

`queued` is a new `AgentStatus`, meaning "waiting for a model slot", distinct
from `paused` (stopped at a resumable point) and `running`. Two writers set
it, both through one conditional update, `markQueued`, so neither can race
the other into overwriting a status a different writer already moved past:

- **tcp-server**, right after it enqueues a start or resume job
  (`AgentOrchestrationService`) — so a wait is visible the instant the job is
  dispatched, not only once the worker happens to run it and finds its pool
  full.
- **tcp-agent's worker**, when `admit()` finds the run's pool or endpoint
  full.

`markQueued` only takes effect on an agent that is `idle`, or `paused` with
its `pausedAt` already cleared by the resume that is claiming it — anything
else means a worker already got there first (it's running, finished,
cancelled, or paused again), and overwriting that status would show a wait
that never ends. `queued` counts as an active status in the UI's existing
active-status set, and `resumeAgent` refuses a `queued` agent — it has
already been dispatched.

A drain only pauses `running` agents, so a `queued` agent's delayed job
survives a restart and runs once a slot is free, same as before 000.03.

## Detail: rate limits

A classified rate limit pauses the agent instead of failing its run:

- **Classification builds on LangChain rather than re-implementing it.**
  `classifyRateLimit(err, provider)`
  (`libs/tcp-shared/src/llm/rate-limit.ts`) calls `@langchain/core`'s own
  exported `classifyRateLimitError`, which already reads `Retry-After`
  (seconds or an HTTP date) and quota-pattern message text — and LangChain
  already retries a 429 hinted at 60 s or less itself, honouring the hint, so
  by the time a classified error reaches tcp-agent's catch it is already one
  LangChain decided not to retry. On top of LangChain's own classification:
  OpenRouter's 402 always means `quota`; a handful of quota error codes
  LangChain doesn't recognise (OpenAI's spend/credit codes, Anthropic's
  `enforced_spend_limit_reached`); Azure's millisecond `retry-after-ms`; and
  each provider's own reset header, read only for the provider the run is
  actually using — never guessed from a header name alone, since OpenAI's
  and Azure's `x-ratelimit-reset-*` share a name but not a unit (a Go-style
  duration string versus plain seconds). See
  [docs/llm-rate-limits.md](../llm-rate-limits.md) for the full per-provider
  table this is built from.
- **A hint-less 429 is `rate`, never guessed as `quota`.** Several providers
  (Mistral, Bedrock, Gemini) often send a bare 429 for an ordinary limit, and
  the doubling backoff below reaches a long wait on its own if the limit
  really does persist — guessing `quota` would needlessly strand a
  merely-busy provider on the much longer quota wait.
- **`resumeAfter` is computed in this order:** the provider's own hint, if
  there is one; otherwise, for `rate`, `RATE_LIMIT_RETRY_MS` (default 60 s)
  doubling on each consecutive rate limit up to `RATE_LIMIT_RETRY_MAX_MS`
  (default 30 min); otherwise, for `quota`, the longer
  `RATE_LIMIT_QUOTA_RETRY_MS` (default 1 h) — a used-up quota is never
  retried every few seconds. With `RATE_LIMIT_AUTO_RESUME=false`,
  `resumeAfter` is `null` and only an explicit resume lifts the pause.
- **A separate 15 s sweep (`RateLimitResumeService`, tcp-server) resumes
  agents whose `resumeAfter` has passed**, independent of the spend-cap
  sweep, because this one must always run — any provider can rate-limit,
  where the spend-cap sweep only starts once a cap is configured.
- **`EXPLICITLY_RESUMABLE` gained `rate_limited`**, so `resume-task` /
  `resume-company` lift a rate-limit pause the same way they already lifted
  a spend-cap or shutdown one, and `pauseResumePrompt()` gained a matching
  continuation prompt.
- **A rate-limited agent always resumes from its checkpoint, never a fresh
  restart.** ADR-031's spend-cap rule — restart with no continuation prompt
  if the agent has no `llm_response` row yet — doesn't transfer here: a rate
  limit strikes inside the LangGraph loop, after the graph has already
  checkpointed the opening input, so a "restart" would replay the opening
  prompt on top of a checkpoint that already has it. The one case with
  genuinely no checkpoint — a first run refused on its pre-turn compaction
  call, before the opening prompt is ever checkpointed — still fails as
  before, because nothing to resume exists yet.
- **The backoff counter (`rateLimitRetries`) restarts at 1 whenever the run
  made any progress** (a response or an action) before the refusal, and
  otherwise keeps counting up from the agent's last value — so a provider
  that's genuinely still limited after a successful retry doesn't restart at
  the short end of the backoff every time.

## Alternatives considered

- **A single worker-wide concurrency figure, raised or lowered by provider
  mix.** This is what `AGENT_WORKER_CONCURRENCY` already was, and it's
  exactly the problem: one number can't protect a single GPU and also let a
  paid remote provider run several agents at once. Two pools is the smallest
  change that lets both constraints exist together.
- **Per-model limits instead of per-pool.** Rejected as unnecessary
  granularity for what two numbers already solve: a home install's GPU
  doesn't care which model is loaded, only that one request runs at a time,
  and a remote account's limit isn't per model either in practice.
  Per-endpoint overrides cover the cases where it does matter (two local
  servers, one stingier provider) without a config entry per model.
- **BullMQ Pro's group-based concurrency**, a paid feature built for exactly
  this. Rejected on cost — nothing here needs its extra behaviour (per-group
  rate limiting with its own dashboard) for two pools and a handful of
  endpoint overrides.
- **A queue per endpoint**, so BullMQ's own `concurrency` setting did the
  limiting. Rejected: a queue has to exist before a job can be pushed to it,
  and endpoints come from dynamically-configured `llmConfig`s, not a fixed
  list known at boot — one `agent-jobs` queue with an in-memory gate in front
  of it needs no queue lifecycle management.
- **A semaphore per LLM call rather than per run.** Rejected because a paused
  agent's job ends between calls; gating only the call, not the run, would
  hold a slot for a paused agent that isn't using it, starving everyone else
  waiting on that pool.
- **Treating a hint-less 429 as `quota`.** The first draft did this; an Opus
  review during stage 1 changed it, because several providers send a bare
  429 for an ordinary, short-lived limit, and guessing `quota` would strand
  those agents on the much longer quota wait for no reason.
- **Extending the existing spend-cap sweep to also resume rate-limited
  agents.** Rejected: that sweep only starts once `SPEND_CAPS` is
  configured, and a rate limit can happen with no spend cap in the picture
  at all — a separate, always-on sweep is simpler than conditionally
  starting the existing one.

## Consequences

- Two new `TcpAgent` columns, `resumeAfter` (nullable timestamp) and
  `rateLimitRetries` (int, default 0), added by migration
  `AgentRateLimitPause1784840000000` and registered by hand in every
  `app.module.ts` that lists migrations.
- A new `AgentStatus`, `queued`, and a new `PauseReason`, `rate_limited`,
  alongside the existing `user_input` / `consultation` / `shutdown` /
  `spend_cap`.
- A new `ModelSlotService` and `RateLimitResumeService`;
  `AGENT_WORKER_CONCURRENCY` and its Joi entry are retired — if an operator
  still sets it, tcp-agent logs a warning at boot naming `MODEL_CONCURRENCY`
  instead, and ignores it.
- `tcp-stub-llm` gained a `refusal` response option (a 429/402 with an
  optional `Retry-After`), so tests can drive this path without a real
  provider — see [docs/stub-llm.md](../stub-llm.md).
- See [docs/model-concurrency.md](../model-concurrency.md) for the
  operator-facing guide.
- Deferred, each with its own tracked condition in
  [outstanding-issues.md](../outstanding-issues.md): chats aren't
  slot-gated; slots are in-process, assuming one tcp-agent instance; no
  notification for a used-up quota; one 429 doesn't hold an endpoint for
  other agents waiting on it; Gemini's OpenAI-compatible error body is
  unverified for retry hints.
