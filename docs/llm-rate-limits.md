# LLM rate-limit and quota signals

How each provider in the catalogue signals a short-term rate limit versus a
used-up quota or credit balance, and what retry hint (if any) it sends. This
is stage 1 of
[`000.03.01.plan`](<prompts/phase 04 - utility/000.03.01.plan - one queue per local model and long timeouts.md>):
stage 4 builds `classifyRateLimit(err)` from this table, so field names and
units matter more than prose. All providers are reached through LangChain's
`ChatOpenAI`, so every "native" behaviour below is filtered through that one
client — see [Client behaviour](#client-behaviour-langchain--openai-sdk).

Last checked: 2026-10-06.

## Provider table

| Provider                       | Rate-limit status                                                                                                                                                                                                                                                                                     | Quota status                                                                                                                                                                                                                                                             | Retry hints (field: unit)                                                                                                                                                                                                                                                                                                                                   | rate vs quota signal                                                                                                                             | Sources                                                                                                                                                                                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenAI                         | 429, `error.type`/`error.code` = `rate_limit_exceeded`                                                                                                                                                                                                                                                | 429, `error.code` = `insufficient_quota` (also `organization_spend_limit_exceeded`, `project_spend_limit_exceeded`, `organization_usage_limit_exceeded`, `credit_balance_exhausted` — same status)                                                                       | `retry-after`: integer seconds. `x-ratelimit-limit-requests`/`-tokens`: count. `x-ratelimit-remaining-requests`/`-tokens`: count. `x-ratelimit-reset-requests`/`-tokens`: Go-style duration string (`"1s"`, `"6m0s"`)                                                                                                                                       | Same HTTP status (429) for both; only `error.code` tells them apart                                                                              | [Rate limits](https://developers.openai.com/api/docs/guides/rate-limits), [Error codes](https://developers.openai.com/api/docs/guides/error-codes)                                                                                                                                   |
| Anthropic (OpenAI-compat)      | 429, `error.type` = `rate_limit_error`, `error.details.error_code` = `slow_down` (native API only)                                                                                                                                                                                                    | 429, same `error.type` = `rate_limit_error`, but **no `retry-after` header** and `error.details.error_code` = `enforced_spend_limit_reached` (native API; see note)                                                                                                      | `retry-after`: integer seconds, present only for an ordinary rate limit. `anthropic-ratelimit-requests-limit`/`-remaining`: count. `anthropic-ratelimit-requests-reset`: RFC 3339 timestamp. Same shape for `-tokens-`, `-input-tokens-`, `-output-tokens-`                                                                                                 | Status code never distinguishes them — only the _absence_ of `retry-after` plus `error.details.error_code`                                       | [Rate limits](https://platform.claude.com/docs/en/api/rate-limits), [OpenAI SDK compatibility](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk)                                                                                                          |
| Google Gemini (OpenAI-compat)  | 429 (native: `RESOURCE_EXHAUSTED`)                                                                                                                                                                                                                                                                    | Undocumented distinctly — the rate-limits page describes only the spend-based 429                                                                                                                                                                                        | Undocumented for the OpenAI-compatible endpoint. Native API error bodies can carry a `RetryInfo.retryDelay` (protobuf `Duration` string, e.g. `"30s"`) per `google.rpc` conventions, but **neither fetched page confirms this reaches the OpenAI-compatible endpoint's body** — unverified, flagged below                                                   | No documented field; undocumented                                                                                                                | [Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits), [OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)                                                                                                                                               |
| Azure OpenAI                   | 429, message text contains `"Requests to … have been limited"` or `"Rate limit is exceeded"`                                                                                                                                                                                                          | No separate billing/credit error at inference time — a used-up TPM/RPM allocation is still 429; message text contains `"system is experiencing high demand"` for transient capacity throttling                                                                           | `retry-after-ms`: integer milliseconds, present on 429, takes precedence. `x-ratelimit-limit-requests`/`-tokens`: count. `x-ratelimit-remaining-requests`/`-tokens`: count. `x-ratelimit-reset-requests`/`-tokens`: **integer seconds** (Azure's own example values are `"10"`, `"300"` — not the Go-duration string OpenAI uses for the same header names) | No field at all — Azure's own docs say to read the error _message text_ to tell a quota/capacity 429 from a plain rate-limit 429                 | [Quotas and limits](https://learn.microsoft.com/en-us/azure/ai-services/openai/quotas-limits), [Manage quota](https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/quota)                                                                                               |
| Amazon Bedrock (OpenAI-compat) | 429 inferred — the endpoint speaks OpenAI's wire format, so a throttle surfaces as `openai.RateLimitError`; AWS's generic `ThrottlingException` reference lists HTTP 400, but that page documents AWS's JSON-protocol APIs generically, not this OpenAI-shaped endpoint — contradiction flagged below | No distinct quota/billing error documented for the Chat Completions endpoint — Bedrock bills through the AWS account, not a prepaid credit balance, so there is no `insufficient_quota` equivalent; a used-up throughput allocation just looks like sustained throttling | Undocumented for this endpoint specifically. General AWS guidance says to honour a `Retry-After` header "if the service returns" one, but no header name/format is documented for `bedrock-runtime`/`bedrock-mantle`                                                                                                                                        | No field — a used-up quota and ordinary throttling both present as the same 429/`ThrottlingException`; only persistence over time hints at quota | [Chat Completions API](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html), [Quotas](https://docs.aws.amazon.com/bedrock/latest/userguide/quotas.html), [Common errors](https://docs.aws.amazon.com/bedrock/latest/APIReference/CommonErrors.html) |
| Mistral                        | 429 (inferred by analogy to the OpenAI-compatible convention; Mistral's own docs don't state the status code)                                                                                                                                                                                         | Undocumented — reaching the org's monthly spend limit "suspends" API access, with no documented status code                                                                                                                                                              | Undocumented/unreliable. A `Retry-After` header is referenced by third parties, but a community-reported issue says Mistral doesn't reliably send one; no `x-ratelimit-*` headers are documented                                                                                                                                                            | No documented field                                                                                                                              | [Usage and limits](https://docs.mistral.ai/admin/user-management-finops/tier) (official, thin); [GitHub issue #9815](https://github.com/earendil-works/pi/issues/9815) (community, unconfirmed)                                                                                      |
| OpenRouter                     | 429, `error.metadata.error_type` = `rate_limit_exceeded`                                                                                                                                                                                                                                              | 402, `error.metadata.limit_source` ∈ `openrouter_credits` \| `openrouter_key_limit` \| `openrouter_in_flight_budget`                                                                                                                                                     | `Retry-After`: present on both 429 and the in-flight-budget 402. `X-RateLimit-Limit`/`-Remaining`/`-Reset`: unit for `-Reset` not stated in the docs — treat as unconfirmed                                                                                                                                                                                 | Status code alone (429 vs 402); `error.metadata.limit_source`/`error_type` names the mechanism                                                   | [Limits](https://openrouter.ai/docs/api-reference/limits), [Errors](https://openrouter.ai/docs/api-reference/errors)                                                                                                                                                                 |
| Groq                           | 429, message names the limit window hit (e.g. "requests per minute", "tokens per minute")                                                                                                                                                                                                             | No distinct field — a used-up free-tier daily cap is the same 429, with the message naming "tokens per day (TPD)" instead of a per-minute window                                                                                                                         | `retry-after`: integer seconds, present only on 429. `x-ratelimit-limit-requests`/`-tokens`: count (RPD / TPM respectively). `x-ratelimit-remaining-requests`/`-tokens`: count. `x-ratelimit-reset-requests`/`-tokens`: Go-style duration string with fractional seconds (e.g. `"2m59.56s"`, `"7.66s"`)                                                     | No field — only the message text's window name (RPD vs RPM/TPM) hints at quota vs rate                                                           | [Rate limits](https://console.groq.com/docs/rate-limits)                                                                                                                                                                                                                             |
| LM Studio                      | No rate limiting — the local server has no limiter                                                                                                                                                                                                                                                    | N/A                                                                                                                                                                                                                                                                      | N/A                                                                                                                                                                                                                                                                                                                                                         | N/A                                                                                                                                              | No official doc (feature doesn't exist); community source only ([markaicode.com](https://markaicode.com/errors/lm-studio-rate-limit-exceeded-fix/), inferred)                                                                                                                        |
| Ollama                         | No rate limiting locally — `OLLAMA_NUM_PARALLEL` (default 1) serialises requests per model instead of rejecting them; a full `OLLAMA_MAX_QUEUE` (default 512) likely surfaces as a connection/queue error, not a 429                                                                                  | N/A                                                                                                                                                                                                                                                                      | N/A                                                                                                                                                                                                                                                                                                                                                         | N/A                                                                                                                                              | No official doc; community sources only ([localaimaster.com](https://localaimaster.com/blog/ollama-rate-limiting-multi-user), inferred)                                                                                                                                              |

`openai-compatible` (custom servers: llama.cpp, vLLM, Jan, …) isn't a fixed
target — whatever it rate-limits, and how, depends on that server. Treat it
like a local server (no documented convention) unless its specific
deployment is known to add one.

## Per-provider notes

### OpenAI

The Python SDK raises `RateLimitError` for every 429, regardless of cause —
callers are expected to read `error.code` themselves to separate a real rate
limit from a billing problem. There is no 402; everything billing-related
rides on 429.

### Anthropic

The spend-cap 429 is deliberately shaped like a rate-limit 429 (same
`error.type`, same status) specifically so a naive "retry on 429" client
doesn't loop forever on it either way; the one documented tell is the missing
`retry-after` header. `error.details.error_code` is documented against the
native Messages API response shown in Anthropic's own example — the OpenAI
compatibility page says error _messages_ aren't equivalent between the two
("the compatibility layer maintains consistent error formats... detailed
error messages will not be equivalent"), but is silent on whether
`error.details` round-trips through the OpenAI-shaped body at all. **This is
the main unverified claim in this table** — stage 4 should treat
`error.details.error_code` as unconfirmed on the compat endpoint and lean on
"429 with no `retry-after`" as the more reliable Anthropic quota signal.

Anthropic's own compatibility doc lists `x-ratelimit-limit-requests`,
`x-ratelimit-remaining-requests`, `x-ratelimit-reset-requests` (and the
`-tokens` equivalents) and `retry-after` as "fully supported" over the
OpenAI-compatible endpoint — using OpenAI's header _names_, not the native
`anthropic-ratelimit-*` names. Which naming a real response actually uses
wasn't independently confirmed by a live call; the two docs disagree only in
which header family they advertise, not in units (both are seconds/counts).

Anthropic's OpenAI-compatible endpoint is explicitly "not considered a
long-term or production-ready solution" per Anthropic's own doc — it's fine
for TCP's purposes, but a future format change is Anthropic's own stated
risk, not a TCP bug.

### Google Gemini

Both fetched pages are thin on error-body detail; the native API's
`RetryInfo`/`retryDelay` behaviour comes from general `google.rpc` Status
conventions, not from a page that names Gemini specifically alongside the
OpenAI-compatible endpoint. Flag this provider's row as the least-verified
in the table — stage 4's classifier should not depend on a Gemini-specific
field until this is checked against a real 429 response body.

### Azure OpenAI

Azure's `x-ratelimit-reset-*` pair is a trap: it shares a header _name_ with
OpenAI's own API, but OpenAI's is a Go-duration string (`"6m0s"`) while
Azure's documented example values are plain integer seconds (`"10"`,
`"300"`). A parser keyed only on header name, not provider, will
misinterpret one of the two.

Azure's own guidance is unusually explicit that **the same HTTP 429 covers
rate limiting, transient capacity throttling, and a temporarily-reduced
effective limit under shared-pool pressure** — distinguishing them is a
documented table of message-text substrings, not a status code or field.

### Amazon Bedrock

The AWS "Common Errors" reference (`ThrottlingException` → HTTP 400) is for
AWS's generic JSON-RPC-style error protocol, used by APIs like
`InvokeModel`. The Chat Completions / Responses endpoints this plan targets
speak OpenAI's wire format instead (confirmed by the SDK code samples using
`OpenAIError`/`openai.RateLimitError`), so a throttle there almost certainly
surfaces as a 429, not 400 — but no Bedrock page states this for the
OpenAI-compatible endpoint directly. Treat 429 as the working assumption,
confirmed only by inference from the client library used, not a cited
status-code table.

### Mistral

The only concrete, citable fact is that a monthly spend limit "suspends" API
access. Everything else — the 429 convention, any retry header, the
quota/rate distinction — is either absent from Mistral's own docs or
contradicted by a community bug report. Stage 4 should fall back to the
generic "no hint" path for Mistral until Mistral documents more.

### OpenRouter

The cleanest table in this set: two different status codes (429 vs 402) for
two different problems, plus a body field inside `error.metadata` for each.
The in-flight-budget case is the one place a 402 still carries `Retry-After`
— OpenRouter expects that one to clear on its own as concurrent requests
finish.

### Groq

Groq's reset-duration format (`"2m59.56s"`) matches OpenAI's family
(`N`h`N`m`N`s) but always includes fractional seconds, unlike OpenAI's
`"6m0s"`/`"1s"` examples. A duration parser should accept a fractional
seconds component regardless of provider.

### LM Studio and Ollama

Neither ships a rate limiter for its local server. A 429 that appears to
come from "LM Studio" is from whatever remote provider a plugin or proxy in
front of it is forwarding to — not from LM Studio itself. `classifyRateLimit`
should simply never see a 429 from these two in normal operation; one
arriving would point at a reverse proxy or a misconfigured base URL, not an
actual local rate limit.

## Client behaviour (LangChain / OpenAI SDK)

Versions checked (root `node_modules`, which is what the workspace actually
resolves — `apps/backend` has no `node_modules` of its own): `openai@6.44.0`,
`@langchain/openai@1.5.5`, `@langchain/core@1.2.3`, `@langchain/langgraph@1.4.8`.

### 1. Does the thrown error keep `status`, `headers` and the body?

Yes, for a 429. `wrapOpenAIClientError`
(`node_modules/@langchain/openai/dist/utils/client.cjs:9-26`) matches
`status === 429` and calls `addLangChainErrorFields(e, "MODEL_RATE_LIMIT")`
(`node_modules/@langchain/core` → re-exported from
`@langchain/core/dist/errors` via `@langchain/openai/dist/utils/errors.cjs`).
That function **mutates and returns the same error object** — it only
appends a troubleshooting-URL sentence to `.message` and sets
`.lc_error_code`:

```js
function addLangChainErrorFields(error, lc_error_code) {
  error.lc_error_code = lc_error_code;
  error.message = `${error.message}\n\nTroubleshooting URL: ...`;
  return error;
}
```

The object itself is still the OpenAI SDK's `RateLimitError`
(`node_modules/openai/src/core/error.ts:141`), which extends
`APIError<429, Headers>` (line 8) and carries, as plain `readonly` fields set
in its constructor (lines 26-37): `status` (`429`), `headers` (a real Fetch
`Headers` instance, so `.get('retry-after')` works), `error` (the parsed
JSON body's `error` object), `code`, `param`, `type`, and `requestID`. All of
these survive LangChain's wrapping untouched — only `message` and
`lc_error_code` change.

### 2. How does LangChain retry a 429, and does it honour `Retry-After`?

The OpenAI SDK's **own** retrying is disabled under LangChain: `ChatOpenAI`
builds its internal `OpenAI` client with `maxRetries: 0`
(`node_modules/@langchain/openai/dist/chat_models/base.cjs:281`, inside
`_getClientOptions`). All retrying happens one layer up, in
`@langchain/core`'s `AsyncCaller`, constructed in `BaseLanguageModel`'s
constructor from the fields passed to `ChatOpenAI`
(`node_modules/@langchain/core/dist/language_models/base.cjs:187`:
`this.caller = new AsyncCaller(params ?? {})`). `buildChatModel`
(`libs/tcp-shared/src/llm/llm-factory.ts`) never sets `maxRetries`, so
`AsyncCaller`'s default of 6 applies.

**This is the one place this table changes the plan's stated premise.** The
plan's context says LangChain "retries it 6 times with its own backoff
(ignoring `Retry-After`)". In the installed version, `AsyncCaller`'s
`defaultFailedAttemptHandler`
(`node_modules/@langchain/core/dist/utils/async_caller.cjs:133-159`) already
classifies every 429 via the exported `classifyRateLimitError`
(same file, lines 99-127; publicly exported from
`@langchain/core/utils/async_caller`, confirmed in
`node_modules/@langchain/core/package.json:629-636`):

- It reads a `retry-after` value off `error.headers` or `error.response.headers`
  (`_getRetryAfterHeader`, lines 52-61) and parses it as seconds or an
  HTTP-date (`parseRetryAfterMs`, lines 87-98), or failing that scans the
  message text for phrases like "try again in 20s" (lines 35, 62-73).
- `error.code === 'insufficient_quota'`, or the message matching one of
  eight quota-exhaustion patterns (lines 25-34: `insufficient_quota`,
  "exceeded ... quota", "usage quota", "quota exhausted", "billing",
  "credit balance", "out of credits", "will reset at") → throws a renamed
  `InsufficientQuotaError`/`RateLimitQuotaExhaustedError` **immediately**,
  with `.rateLimitType`/`.rateLimitReason` set on it. No further retries,
  regardless of `maxRetries`.
- A retry-after hint ≤ 60 000 ms → classified `"wait"`: the handler
  **returns normally** (no throw), after setting `.retryAfterMs` on the
  same error object. `p-retry`
  (`node_modules/@langchain/core/dist/utils/p-retry/index.cjs:65-66`) then
  computes `Math.max(exponentialBackoffDelay, error.retryAfterMs)` as the
  actual wait — **`Retry-After` genuinely is honoured today**, as a floor
  under the normal `factor:2, minTimeout:1000ms, randomize:true` backoff.
- A hint > 60 000 ms, or no hint at all (a headerless 429) → classified
  `"capacity"`: throws a renamed `RateLimitCapacityError` **immediately**.
  No retries.

Net effect: of the 6 configured retries, only a 429 carrying a short
(≤60s) retry-after-style hint actually gets retried with backoff. Every
other 429 — headerless, or with a long/quota hint — fails after the first
attempt, already carrying LangChain's own `.rateLimitType`/
`.rateLimitReason`/`.retryAfterMs`. `STATUS_NO_RETRY` (line 13-23) includes
402, so OpenRouter's credit-exhausted response is thrown on the first
attempt too, before the 429-only classifier ever runs.

This also means stage 4 doesn't have to reimplement this classification
from scratch — `classifyRateLimitError` and `parseRetryAfterMs` are already
public exports of `@langchain/core/utils/async_caller` and could be reused
or mirrored directly, rather than treating the plan's from-scratch
`classifyRateLimit(err)` as the first classifier in the pipeline.

### 3. Does a 429 arrive wrapped by something else before the agent loop sees it?

No extra wrapping was found on the live (non-resumed) path. The chain is:

- `graph.streamEvents(...)` in `runSupervisedGraph`
  (`libs/tcp-shared/src/llm/run-supervised-graph.ts:200-254`) is iterated
  with `for await`; its `catch` (line 228) only special-cases
  `isContextLengthError(err)` — anything else is `throw err;` (line 253),
  unchanged.
- `SupervisedTurnService.run`
  (`apps/backend/apps/tcp-agent/src/agent/supervised-turn.service.ts:64-97`)
  adds no `try`/`catch` of its own; it just returns the promise.
- `AgentLoopService.driveToTerminal`'s `catch`
  (`apps/backend/apps/tcp-agent/src/agent/agent-loop.service.ts:300-304`) is
  therefore the first point in the agent loop that sees the raw error — the
  same object `AsyncCaller` produced, with `status`/`headers`/`error`/`code`
  still attached.
- From there it's immediately reduced: `describeRunFailure`
  (`apps/backend/apps/tcp-agent/src/agent/run-status.service.ts:45-55`)
  returns only `err.message` (or a generic fallback) for `failRun`'s audit
  reason. **A stage-4 classifier must run on `err` inside this `catch`,
  before `describeRunFailure` is called** — today, by the time a 429
  reaches `failRun`, every field but the message string is already gone.

One caveat found while reading LangGraph's Pregel loop, not confirmed to be
on this codebase's hot path: on a _resumed_ run, LangGraph can rebuild an
error for its own node-level error-handler feature from checkpoint data as
`new Error(value?.message ?? String(value))`
(`node_modules/@langchain/langgraph/dist/pregel/loop.cjs:627-631`),
discarding every field but `.message`/`.name`. This is LangGraph's own
per-node error-handler mechanism; `buildAgentGraph` wasn't checked for
whether it registers one, but nothing in `run-supervised-graph.ts` suggests
it does. Worth a quick confirmation in stage 4, not a blocker here.

## Parser rules

Recommended precedence for computing `retryAt` (first match wins):

1. `retry-after-ms` (Azure): integer milliseconds, added straight to now.
2. `Retry-After` / `retry-after` (OpenAI, Anthropic, Groq, OpenRouter,
   Azure): if the value parses as a plain number, treat it as seconds; if
   not, parse it as an HTTP-date (RFC 7231) and use that time directly.
3. A provider reset header, read only from the provider the config names
   (never guessed from the header name alone, per the Azure/OpenAI
   `x-ratelimit-reset-*` naming collision above):
   - Anthropic's `anthropic-ratelimit-*-reset`: RFC 3339 timestamp — use
     directly, don't add to now.
   - OpenAI's / Groq's `x-ratelimit-reset-*`: Go-style duration string
     (`\d+h`? `\d+m`? `\d+(\.\d+)?s`?) — parse each component and add to
     now.
   - Azure's `x-ratelimit-reset-*`: plain integer seconds — add to now.
4. `error.retryAfterMs`, if LangChain's own `AsyncCaller` already set it
   (see [Client behaviour](#client-behaviour-langchain--openai-sdk) §2) —
   redundant with #1/#2 for a 429 that passed through it, but a safety net,
   and a candidate to import directly from
   `@langchain/core/utils/async_caller` instead of re-deriving the same
   seconds/HTTP-date parsing stage 4 would otherwise write from scratch.
5. No hint found at all → fall through to the plan's fixed backoff
   (`RATE_LIMIT_RETRY_MS`, doubling to `RATE_LIMIT_RETRY_MAX_MS`) rather than
   guessing a time.

Quota classification (checked before the retry-hint precedence above, since
a quota result ignores any `retry-after` it happens to carry):

1. Status `402` (OpenRouter) → `quota`, unconditionally.
2. Status `429` and `error.code`/`error.type` is `insufficient_quota`
   (OpenAI) → `quota`.
3. Status `429` with no retry hint at all stays `rate`, not `quota`. Anthropic's
   spend-cap 429 and Azure's capacity throttle look like this, but so does an
   ordinary rate limit from Mistral, Bedrock or Gemini, which often send no
   header. The doubling backoff reaches long waits on its own if the limit
   persists, so a missed quota costs a few early retries rather than an hour's
   wait on a short limit. _Changed in review (Opus): the first draft classed
   these as `quota`._
4. Status `429` and the message text matches a quota-exhaustion pattern —
   reuse `@langchain/core`'s own `QUOTA_EXHAUSTED_MESSAGE_PATTERNS` list
   (`insufficient_quota`, "exceeded ... quota", "usage quota", "quota
   exhausted", "billing", "credit balance", "out of credits", "will reset
   at") rather than re-deriving it — this is the only portable signal for
   Groq, Mistral and Bedrock, none of which expose a dedicated field.
5. Otherwise → `rate`.
