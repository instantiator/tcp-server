# Spend caps

Every LLM call's token usage is recorded automatically. Caps on top of that
are optional: set `SPEND_CAPS` in your env file to put a ceiling on a
provider's spend, with notifications and a chosen action for when it's
reached. See [ADR-031](ADRs/ADR-031-spend-tracking-and-notifications.md) for
why this is built the way it is.

## What is tracked

Every LLM call's input and output tokens — every agent turn, every
compaction call, every chat message. Not tracked:

- **Embeddings.** LangChain's embeddings client doesn't report a token count
  to read.
- **The model-compatibility probe** (`POST /api/model/check`).

A provider that reports no usage at all (its response carries no token
counts) is recorded as untracked instead. You get one `warning` notification
the first time this happens, naming the provider — after that its calls are
silently uncounted, and any cap you've set on it can never be enforced.

## Configuring `SPEND_CAPS`

Set it in your env file (`.env`, `.env.dev`, …) as one JSON object, keyed by
provider id from the provider catalogue (`openai`, `anthropic`, `google`,
`azure`, `amazon-bedrock`, `mistral`, `openrouter`, `lm-studio`, `ollama`,
`openai-compatible`). Leave it unset for no caps at all — a home install
using only a local model never needs this.

```bash
# A classic monthly budget.
SPEND_CAPS={"openai":{"limits":[{"tokens":5000000,"per":"month"}],"notifyAt":[80],"action":"pause"}}

# A "5h stint + weekly ceiling" shape, similar to a subscription plan's rhythm.
SPEND_CAPS={"anthropic":{"limits":[{"tokens":2000000,"per":"5h"},{"tokens":20000000,"per":"week"}],"notifyAt":[50,80],"action":"pause"}}
```

Each provider's cap has:

| Field      | Meaning                                                                                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `limits`   | One or more `{ tokens, per }` ceilings. Any one of them reached counts as the cap reached.                                                                                                            |
| `per`      | `month` (resets 00:00 UTC on the 1st), `week` (00:00 UTC Monday), `day` (00:00 UTC), or `"<N>h"` (e.g. `"5h"`) — a stint that starts counting from the provider's first use after the last one ended. |
| `notifyAt` | Percentages below 100 that raise a `warning` notification. Default `[80]`. Reaching 100% always raises an `error`, listed or not.                                                                     |
| `action`   | What happens when a limit is reached. Default `pause`. See [actions](#actions) below.                                                                                                                 |

All windows are UTC. There's no per-cap timezone setting — see
[limits and caveats](#limits-and-caveats).

**No defaults per provider.** Published subscription limits change and
aren't published as token counts, and an API key is billed separately from
any subscription anyway. You choose the numbers.

**Several `openai-compatible` endpoints share one cap.** If you point more
than one local or custom server at the `openai-compatible` catalogue entry,
they share its id and so share one cap. See
[limits and caveats](#limits-and-caveats).

## Actions

| Action          | What it does when a limit is reached                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pause`         | Every agent using the provider pauses at its next LLM call, with its work saved. This is the default.                                                        |
| `finish-agents` | An agent already running finishes its current run; an agent that hasn't made its first LLM call yet is held back until the cap resets or is lifted.          |
| `finish-tasks`  | Nothing is held back in the agent loop. The web UI's "start now" default for new tasks switches to off, so you decide task by task whether to keep spending. |

Chats are always counted but never held back by any action — a chat is
something you're actively having, not unattended work.

## When a cap is reached

- A `warning` notification fires at each `notifyAt` percentage, and an
  `error` notification fires when the cap is reached.
- Agents affected by `pause` or `finish-agents` pause with their checkpoint
  intact — nothing is lost, and they resume where they left off. (An agent
  held back before its first LLM call has nothing saved yet, so it simply
  starts.)
- Chats keep working regardless of the action.
- **A task you start while a cap is reached, or resume, keeps running until
  it ends.** Starting or resuming is you choosing to spend; the cap won't
  pause that task again at its next call.
  A task started automatically (once scheduling exists) does not get this
  exemption.

A cap can be overshot by however many calls are already in flight when it
trips — the gate only stops the _next_ call. **Also set a hard spend limit in
each provider's own console.** That's the real backstop; this system's cap is
a courtesy, not a guarantee.

## Resuming paused work

| Where  | How                                                                                                                        |
| ------ | -------------------------------------------------------------------------------------------------------------------------- |
| Web    | Notifications tab on the company page → a cap-reached notification → **Resume this company's paused work**                 |
| CLI    | `tcp-cli.sh resume-task --task-id <uuid>` or `resume-company --company-id <id-or-slug>`                                    |
| Admins | `tcp-cli.sh dismiss-cap --provider <id> [--indefinitely]` lifts the cap itself; `restore-cap --provider <id>` puts it back |

Resuming a task or a company exempts just that task (or that company's
paused tasks) until they end — it doesn't lift the cap for anyone else.
Lifting a cap with `dismiss-cap` does, for every company, which is why it's
restricted to administrators. There is no "lift until reset" button in the
web UI for the same reason: only administrators may lift a cap, and the web
client has no way to tell a non-admin apart, so a button that always failed
for everyone else would be worse than no button.

## Resets

A `month`/`week`/`day` window resets at its fixed UTC time; an `<N>h` stint
resets `N` hours after it started. Once a window resets, the reset sweep
(checked every 60 seconds) clears the reached state and automatically resumes
every agent that cap had paused — a cap you configured, unlike a system
shutdown, should let paused work start again without you having to come back
and resume it by hand. An agent whose provider is still capped for some other
reason just pauses again at its next check, spending nothing.

## Seeing usage

- **Web:** a thin meter under each breadcrumb — the application crumb shows
  the provider closest to its cap, the company crumb shows that company's own
  usage. A tooltip gives the exact numbers, the action, and the next reset.
  With no caps configured, the bar shows full and just reads the tokens used
  since tracking began.
- **CLI:** `tcp-cli.sh usage` for every cap's progress and application
  totals; add `--company-id <id-or-slug>` for that company's per-task usage
  and its last 24 hours in five-minute buckets.
- **API:** `GET /api/spend` for the application-wide view (open to any
  signed-in user); `GET /api/company/:id/spend` for one company's totals,
  per-task totals, and the recent series (needs membership in that company).

## Limits and caveats

- **Overshoot.** A cap can be exceeded by whatever calls are in flight when
  it trips. Set a hard limit in each provider's own console too.
- **Untracked providers.** A provider that reports no token usage can't be
  capped — see [what is tracked](#what-is-tracked).
- **Shared `openai-compatible` cap.** Two different `openai-compatible`
  endpoints can't have separate caps today; see
  [outstanding-issues.md](outstanding-issues.md#shared-cap-for-openai-compatible-endpoints).
- **UTC only.** There's no per-cap or per-operator timezone; see
  [outstanding-issues.md](outstanding-issues.md#cap-windows-are-utc-only).
- **One tcp-server instance.** Cap evaluation is serialised in-process, per
  provider, inside tcp-server; see
  [outstanding-issues.md](outstanding-issues.md#single-tcp-server-instance-assumption-in-spendcapservice).
