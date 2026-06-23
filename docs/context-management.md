# Context Management

This document covers how the LCP server manages the LLM context window during agent conversations.

## Overview

Each message turn in a chat session assembles a prompt from conversation history, system configuration, and the new user message, then invokes the LLM. As conversations grow, the combined prompt can exceed the model's context window. The context management system detects this and compacts the context before the invocation.

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

| Threshold | Value | Description |
|---|---|---|
| Trigger | 80% | Compaction is triggered when the context exceeds this fraction of the window |
| Target | 60% | Compaction aims to bring the context below this fraction |

## Compaction strategies

Strategies are applied in order from cheapest to most expensive:

### Tier 1: Sliding window (no LLM call)

Uses `trimMessages` from `@langchain/core/messages` with tiktoken token counting. The system message is always retained; oldest messages are dropped first to bring the history below the target threshold. This handles the common case with no additional inference cost.

### Tier 2: LLM summarisation (only when Tier 1 isn't enough)

Individual messages that are too large to fit within the per-message budget after trimming are summarised to bullet-point essentials. Multiple oversized messages are summarised in parallel.

When prompt sections (role description, company environment, RAG data, MCP responses) are implemented, each section can be summarised independently and in parallel.

### Incoming data guard

Before any new data (user message, RAG results, MCP responses) is added to the context, its size is checked. If it would push the total over the trigger threshold, it is compacted first. If shared storage is available, very large payloads will be stored there with a compact reference summary included in the context instead (not yet implemented — see [ADR-007](ADRs/ADR-007-shared-company-storage.md)).

## Compaction reporting

### Response JSON

When compaction runs, `ChatMessageResponse` includes a `compactionReport` field:

```json
{
  "response": "...",
  "compactionReport": {
    "strategies": ["trim_messages"],
    "activities": ["Trimmed history from 24 to 8 messages (removed 16)"],
    "duration": 45,
    "before": { "tokens": 6800, "windowSize": 8192, "pct": 83.0 },
    "after":  { "tokens": 4200, "windowSize": 8192, "pct": 51.3 }
  }
}
```

The `lcp-cli` displays this after the response.

### SSE event stream

`GET /api/agent/:id/events` (SSE) streams real-time events during processing. Connect to this endpoint to observe compaction progress without waiting for the response:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/agent/<id>/events
```

Events:

| Kind | When |
|---|---|
| `processing_started` | LLM invocation has begun |
| `compaction_started` | Compaction triggered; includes `tokensBefore`, `windowSize`, `pct`, `strategies` |
| `compaction_complete` | Compaction finished; includes `tokensAfter`, `windowSize`, `pctAfter`, `durationMs`, `activities` |
| `processing_complete` | LLM response received |

The CLI automatically connects to this stream after 3 seconds of no response from the server, displaying compaction events in real time.

## Audit log

Compaction activity is written to the `audit_events` table as `Decision` events with payloads:

- `compaction_triggered` — before compaction, with token counts and strategies
- `compaction_complete` — after compaction, with updated token counts and per-activity log

## Architecture

See [ADR-013](ADRs/ADR-013-prompt-assembly-context-management.md) for the full design rationale, including the 8-part prompt structure, open questions (essential-information anchoring), and future work (per-role thresholds).

### Services

| Service | Location | Purpose |
|---|---|---|
| `ContextBudgetService` | `src/context/context-budget.service.ts` | Token counting and budget thresholds |
| `ContextCompactorService` | `src/context/context-compactor.service.ts` | Trim and summarise operations |
| `IncomingDataGuardService` | `src/context/incoming-data-guard.service.ts` | Pre-check incoming data size |
| `ContextManagerService` | `src/context/context-manager.service.ts` | Orchestrates budget checks and compaction |
| `AgentEventService` | `src/events/agent-event.service.ts` | In-memory SSE event bus per agent |
