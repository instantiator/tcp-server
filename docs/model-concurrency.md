# Model concurrency and rate limits

How many agents can run at once, per model, and what happens when a provider
refuses a call. See [ADR-032](ADRs/ADR-032-model-concurrency-and-rate-limits.md)
for why this is built the way it is.

## Why this exists

A home install usually has one GPU, so two agents running at the same time
really means one running and one waiting inside the local model server — a
wait that, with no visibility, looks exactly like a hang. A remote provider
can usually do more at once, but letting agents fan out against it with no
limit also means an unbounded spend rate: more parallel agents, more calls
per minute, a bigger bill.

`MODEL_CONCURRENCY` sets two things at once: how many agents may use your
local hardware at a time, and how fast a paid provider can be spent against.

## Configuring `MODEL_CONCURRENCY`

Set it in your env file (`.env`, `.env.dev`, …) as one JSON object, in
tcp-agent's environment:

```bash
# Ships with these defaults even if you never set this at all.
MODEL_CONCURRENCY='{"local":1,"remote":4}'

# Raise the local pool (e.g. a workstation GPU that can take two agents at
# once) and lower the remote one, plus a tighter limit on one endpoint.
MODEL_CONCURRENCY='{"local":2,"remote":2,"endpoints":{"anthropic":1}}'
```

**Keep the single quotes.** `start-deployment.sh` loads the env file with
bash, which strips unquoted double quotes and leaves broken JSON — tcp-agent
then refuses to start rather than guess at what you meant.

| Field       | Meaning                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `local`     | How many agents may run at once against every local/custom model combined. Default `1`. `null` means unlimited.               |
| `remote`    | How many agents may run at once against every remote provider combined. Default `4`. `null` means unlimited.                  |
| `endpoints` | Optional. One extra limit for one specific endpoint, on top of its pool. Omit an endpoint for no extra limit beyond the pool. |

An agent starts only when both its pool and, if one is set, its endpoint have
room. Leave the whole setting unset for the shipped defaults — `local: 1`,
`remote: 4`, no endpoint overrides.

### Pools: `local` vs `remote`

Every provider in the catalogue is either `local` (LM Studio, Ollama, any
`openai-compatible` custom server) or `remote` (OpenAI, Anthropic, Google,
Azure, Bedrock, Mistral, OpenRouter). A `custom` server counts as `local` —
it's still your own machine serving one model at a time, not a metered
account that can take more load.

### Endpoint keys: what goes in `endpoints`

The key for `endpoints` depends on what kind of provider it is:

- **A remote provider**, by its catalogue provider id — `anthropic`,
  `openai`, `google`, `azure`, `amazon-bedrock`, `mistral`, `openrouter`.
  Rate limits and spend are tied to your account with that provider, not to
  a URL.
- **A local or custom provider**, by its base URL exactly as configured on
  the role or company (case and a trailing slash don't matter — they're
  normalised before comparing). One server is one GPU, whatever model it's
  currently serving.

```bash
# Two local servers on different machines, each with its own limit, plus a
# tighter cap on Anthropic than the remote pool default.
MODEL_CONCURRENCY='{"local":2,"remote":4,"endpoints":{"http://gpu-box:1234/v1":1,"http://laptop:1234/v1":1,"anthropic":2}}'
```

An endpoint limit never raises the pool total — both still have to agree.

### `AGENT_WORKER_CONCURRENCY` is retired

This setting replaces the older `AGENT_WORKER_CONCURRENCY` (a single global
figure). If it's still set in your env file, tcp-agent logs a warning at boot
naming `MODEL_CONCURRENCY` and ignores it — remove it from your env file once
you see that warning.

## What "Waiting for model" means

An agent shows `queued` — "Waiting for model" in the web UI and CLI — when
its pool or endpoint is full. This is not stuck: it is holding its place in
line, and starts as soon as a slot frees from whatever is running ahead of
it. tcp-server marks an agent `queued` the moment it dispatches its job, and
tcp-agent's worker marks it `queued` again if the pool fills in the time
between dispatch and the worker actually picking the job up — either way, the
wait is visible straight away rather than only once you notice nothing is
happening.

A `queued` agent counts as active, the same as `running`, in every list and
count that shows active work.

## Rate limits

A provider refusing a call with HTTP 429 (or, for OpenRouter, 402) no longer
fails the agent's run. It pauses instead, shows as `rate_limited`, and tries
again once the wait is over — the same shape a spend cap pause already had.

- **A short-hinted 429 (60 seconds or less) never reaches this pause at
  all** — LangChain retries it itself first, honouring the provider's own
  `Retry-After`.
- **Everything else pauses the agent**, with its LangGraph checkpoint
  intact, so resuming carries on from exactly where it stopped rather than
  replaying the opening prompt.
- **A used-up quota or credit balance** waits far longer than an ordinary
  rate limit, on the understanding that it usually needs a person to add
  funds or wait out a billing period, not a few seconds.
- **The provider's own hint, when it sends one, always wins** over any of
  the defaults below.

See [docs/llm-rate-limits.md](llm-rate-limits.md) for exactly how each
provider in the catalogue signals a rate limit versus a used-up quota, and
what hint (if any) it sends.

### The four `RATE_LIMIT_*` settings

All four live in tcp-agent's environment (or tcp-server's, for
`RATE_LIMIT_AUTO_RESUME`, which the resume sweep also reads). Defaults are in
`.env.example`:

| Setting                     | Default   | Meaning                                                                                    |
| --------------------------- | --------- | ------------------------------------------------------------------------------------------ |
| `RATE_LIMIT_AUTO_RESUME`    | `true`    | Set `false` to leave every rate-limited agent paused until someone resumes it by hand.     |
| `RATE_LIMIT_RETRY_MS`       | `60000`   | First wait after a hint-less rate limit, in milliseconds. Doubles on each consecutive one. |
| `RATE_LIMIT_RETRY_MAX_MS`   | `1800000` | Ceiling for that doubling wait (30 minutes).                                               |
| `RATE_LIMIT_QUOTA_RETRY_MS` | `3600000` | Wait after a used-up quota or credit balance (1 hour) — deliberately much longer.          |

With `RATE_LIMIT_AUTO_RESUME=false`, a rate-limited agent's "next try" is left
unset, and it reads "resume by hand" in the web UI and CLI instead of a time.

## Resuming by hand

A rate-limited agent normally resumes on its own — a 15-second sweep in
tcp-server checks for anything whose wait is over, independently of the
spend-cap sweep, so it works whether or not you've configured `SPEND_CAPS` at
all. Resume one yourself the same way you'd resume a spend-capped task:

```bash
./tcp-cli.sh -t $TOKEN resume-task --task-id <uuid>
./tcp-cli.sh -t $TOKEN resume-company --company-id <id-or-slug>
```

See [tcp-cli.md](tcp-cli.md#resume-task) for the full command reference.
Resuming is also what to do with `RATE_LIMIT_AUTO_RESUME=false` — the pause
never clears on its own until you do.
