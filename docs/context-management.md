# Context Management

This document covers how the LCP server manages the LLM context window during agent conversations.

## Overview

Each message turn in a chat session, and every iteration of an lcp-agent worker run, assembles a prompt from conversation history, system configuration, and the new user message, then invokes the LLM. As conversations grow, the combined prompt can exceed the model's context window. The context management system detects this and compacts the context before the invocation.

Budget checks run **once per tool-calling iteration**, not just once at the start of a turn — a long-running agent that calls several tools in sequence is re-checked after each one, not only before its first model call. Both `chat.service.ts` (lcp-server) and `agent-loop.service.ts` (lcp-agent's worker, covering standard runs, resumed runs, and consulted-agent runs) share this behaviour via `runSupervisedGraph` (`libs/lcp-shared/src/llm/run-supervised-graph.ts`).

## Context window size

The model's context window is configured via `LlmConfig.contextWindow` (tokens). If absent, the default is `8192` tokens. Set this when creating or updating a role's LLM config:

```json
{
  "provider": "lm-studio",
  "model": "qwen3-14b",
  "baseUrl": "http://localhost:1234/v1",
  "contextWindow": 32768
}
```

## Compaction thresholds

| Threshold | Value | Description                                                                  |
| --------- | ----- | ---------------------------------------------------------------------------- |
| Trigger   | 80%   | Compaction is triggered when the context exceeds this fraction of the window |
| Target    | 60%   | Compaction aims to bring the context below this fraction                     |

## Compaction strategies

Strategies are applied in order from cheapest to most expensive:

### Tier 1: Sliding window (no LLM call)

Uses `trimMessages` from `@langchain/core/messages` with tiktoken token counting. The system message is always retained; oldest messages are dropped first to bring the history below the target threshold. This handles the common case with no additional inference cost.

### Tier 2: LLM summarisation (only when Tier 1 isn't enough)

Individual messages that are too large to fit within the per-message budget after trimming are summarised to bullet-point essentials. Multiple oversized messages are summarised in parallel.

When prompt sections (role description, company environment, RAG data, MCP responses) are implemented, each section can be summarised independently and in parallel.

### Tool-schema token counting

`ContextBudgetService.countTools(tools)` counts the exact JSON schema LangChain's `bindTools` sends for every currently-bound tool (via `convertToOpenAITool`), and this is folded into every "current tokens" calculation. Bound-tool overhead was previously invisible to budgeting — a run with several MCP servers loaded could be much closer to its window limit than message-only counting suggested. This is also why [tool-schema gating](#tool-schema-gating) matters for budgeting, not just prompt hygiene: narrowing which tools are bound directly reduces the counted total.

### Reactive backstop

The proactive tiktoken-based estimate can still be wrong (encoding differences between providers, provider-side overhead not visible to the client). Every model-streaming pass is wrapped in a `try/catch` classifying context-length-exceeded errors via `isContextLengthError` (`libs/lcp-shared/src/llm/context-length-error.ts`, matching common provider substrings like `"context_length_exceeded"`, `"maximum context length"`, `"context window"`). On a match: if compaction hasn't already been attempted this cycle, it compacts once and retries; if it has, the run fails cleanly with `"Context window exceeded even after compaction"` rather than retrying indefinitely.

### Incoming data guard

Before any new data (user message, RAG results, MCP responses) is added to the context, its size is checked. If it would push the total over the trigger threshold, it is compacted first. If shared storage is available, very large payloads will be stored there with a compact reference summary included in the context instead (not yet implemented — see [ADR-007](ADRs/ADR-007-shared-company-storage.md)).

### Tool-schema gating

Only each MCP server's `describe_server` tool is bound to the model until the agent calls it; the server's other tools then become bound for a small number of iterations before being hidden again (`ToolVisibilityTracker`, `libs/lcp-shared/src/llm/tool-visibility-tracker.ts`). This is per-run, in-memory state — not persisted in the LangGraph checkpoint — so a process restart simply costs one extra `describe_server` call on retry. The `interactions` server is exempt (its tools, e.g. `complete_task`, are essential control-flow calls that must always stay reachable). See [agent-services.md](agent-services.md#enabling-mcp-tools-for-a-role) and [ADR-013 Amendments](ADRs/ADR-013-prompt-assembly-context-management.md#amendments-as-implemented-0086).

## Compaction reporting

Turn processing is detached from the HTTP request/response: `POST /api/agent/:id/message` returns `202 Accepted` immediately, and all turn activity — including compaction — streams over SSE (see [ADR-015](ADRs/ADR-015-agent-completion-sse.md)). There is no `compactionReport` field on any HTTP response; the final `completed` SSE event's payload carries the compaction summary instead.

### SSE event stream

`GET /api/agent/:id/events` (SSE) streams real-time events for the whole turn/run — connect immediately, not after a delay, since the response body itself carries no content:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/agent/<id>/events
```

Events (non-exhaustive — see [ADR-015](ADRs/ADR-015-agent-completion-sse.md) for the full `AgentEvent` union):

| Kind                  | When                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `compaction_started`  | Compaction triggered (proactively or reactively); includes `tokensBefore`, `windowSize`, `pct`, `strategies` |
| `compaction_complete` | Compaction finished; includes `tokensAfter`, `windowSize`, `pctAfter`, `durationMs`, `activities`            |
| `llm`                 | Model activity (reasoning/response deltas, tool calls)                                                       |
| `completed`           | Terminal event; payload includes the final `compactionReport` if compaction ran during the run               |

`lcp-cli chat` connects to this stream as soon as a turn is dispatched and renders events in real time.

## Audit log

Compaction activity is written to the `audit_events` table as `Decision` events with payloads:

- `compaction_triggered` — before compaction, with token counts and strategies
- `compaction_complete` — after compaction, with updated token counts and per-activity log

## Architecture

See [ADR-013](ADRs/ADR-013-prompt-assembly-context-management.md) for the full design rationale, including the 8-part prompt structure, open questions (essential-information anchoring), and future work (per-role thresholds).

### Services

`ContextBudgetService`, `ContextCompactorService`, `IncomingDataGuardService`, and `ContextManagerService` live in `libs/lcp-shared/src/context/` (moved from `apps/lcp-server/src/context/` in 008.6 so lcp-agent's worker can share them). `ContextManagerService` depends on two small structural sink interfaces (`ContextEventSink`, `ContextAuditSink`) rather than lcp-server's concrete services directly, so both lcp-server and lcp-agent can wire it to their own event/audit implementations.

| Service/module             | Location                                                     | Purpose                                                                                         |
| -------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `ContextBudgetService`     | `libs/lcp-shared/src/context/context-budget.service.ts`      | Token counting (messages + bound tools) and budget thresholds                                   |
| `ContextCompactorService`  | `libs/lcp-shared/src/context/context-compactor.service.ts`   | Trim and summarise operations                                                                   |
| `IncomingDataGuardService` | `libs/lcp-shared/src/context/incoming-data-guard.service.ts` | Pre-check incoming data size                                                                    |
| `ContextManagerService`    | `libs/lcp-shared/src/context/context-manager.service.ts`     | Orchestrates budget checks and compaction (`prepare()` per-turn, `checkBudget()` per-iteration) |
| `ToolVisibilityTracker`    | `libs/lcp-shared/src/llm/tool-visibility-tracker.ts`         | Describe-then-reveal tool-schema gating                                                         |
| `isContextLengthError`     | `libs/lcp-shared/src/llm/context-length-error.ts`            | Provider-agnostic reactive-backstop classifier                                                  |
| `runSupervisedGraph`       | `libs/lcp-shared/src/llm/run-supervised-graph.ts`            | Shared per-iteration loop: budget, tool visibility, terminal-status, abort-on-pause             |
| `AgentEventService`        | `apps/lcp-server/src/events/agent-event.service.ts`          | In-memory SSE event bus per agent (lcp-server's `ContextEventSink`)                             |
