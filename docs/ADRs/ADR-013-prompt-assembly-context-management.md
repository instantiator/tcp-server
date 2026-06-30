# ADR-013: Agent Prompt Assembly and Context Management

Status: Partially Implemented

## Context

Each LLM invocation for an LCP agent or chat session requires assembling a prompt from several distinct sources: the role's system-level configuration, the company environment, available services (MCP, RAG), the task or query itself, and any retrieved data. As conversations grow, the combined history will exceed the model's context window unless managed explicitly.

This ADR documents:

1. The intended 8-part prompt structure and its current implementation status.
2. The strategy for managing context window usage over the lifetime of a conversation.
3. Decisions about how compaction activity is reported to clients.

## Prompt structure

The intended prompt for each agent turn consists of eight parts, assembled in order:

| #   | Part                 | Source                                                                                              | Status         |
| --- | -------------------- | --------------------------------------------------------------------------------------------------- | -------------- |
| 0   | System prompt        | `LcpRole.systemPromptTemplate` (rendered with `name`, `description`, `date`, `companyId`, `roleId`) | ✅ Implemented |
| 1   | Role prompt          | `LcpRole.rolePrompt` — role identity, attitude, domain knowledge, behavioural guidelines            | ✅ Implemented |
| 2   | Company environment  | `LcpCompany.companyContext` — company name/description, shared context for all agents               | ✅ Implemented |
| 3   | Services available   | Dynamic list generated from `role.mcpServerList`; directs agent to call `describe_server`           | ✅ Implemented |
| 4   | Task / query prompt  | User message or `agent.initialPrompt`                                                               | ✅ Implemented |
| 5   | RAG data             | Top-k chunks retrieved via pgvector cosine similarity for the current query                         | ✅ Implemented |
| 6   | MCP responses        | Tool responses pre-fetched before the turn                                                          | ❌ Not yet     |
| 7   | Conversation history | Maintained implicitly via the LangGraph PostgreSQL checkpoint                                       | ✅ Implemented |
| 8   | Final instruction    | A fixed suffix HumanMessage instructing the agent what to do next                                   | ✅ Implemented |

Part 6 (pre-fetched MCP responses) remains unimplemented; agents call MCP tools reactively via the LangGraph tool node instead.

## Context window management

### Context window size

`LlmConfig.contextWindow` (optional `number`, defaults to `8192`) specifies the model's context window in tokens. Token counting uses the `cl100k_base` tiktoken encoding (bundled via `js-tiktoken`, already a transitive dependency), which is a sufficiently accurate approximation for all currently supported providers.

### Compaction triggers

| Threshold     | Value | Meaning                                                                  |
| ------------- | ----- | ------------------------------------------------------------------------ |
| `TRIGGER_PCT` | 80%   | Compaction is triggered when context exceeds this fraction of the window |
| `TARGET_PCT`  | 60%   | Compaction aims to bring the context below this fraction                 |

These constants are hardcoded in `ContextBudgetService`.

ponytail: move to `LcpRole.runConfig` JSONB when per-role tuning is needed.

### Compaction strategies (in order)

**Tier 1 — fast, no LLM call:**

1. **`trim_messages`**: Uses `trimMessages` from `@langchain/core/messages` with tiktoken token counting. Keeps the system message and the most recent messages up to `TARGET_PCT`. Applied via LangGraph `graph.getState()` + `RemoveMessage` entries in `graph.updateState()`.

**Tier 2 — LLM-assisted, only when Tier 1 is insufficient:**

2. **`summarise_message`**: Oversized individual messages (too large to fit even after trimming) are compressed to bullet-point summaries. Multiple messages are summarised in parallel via `Promise.all`.

3. **`compact_section`**: When prompt sections (role, company env, RAG data, MCP data) are implemented, each will be summarisable in parallel. Deferred until those sections exist.

**Last resort:**

4. **`drop_messages`**: Messages are removed when Tiers 1–3 cannot reach the target. A `// TODO` marks this intervention point for the essential-information-anchoring enhancement (see Open Questions).

### Incoming data guard

Before a new message (or RAG/MCP data) is added to the context, `IncomingDataGuardService` checks whether it would push the total over `TRIGGER_PCT`. If so, it compacts the incoming data using `compact_section` before inclusion. If compacted data still doesn't fit and an overflow path and `MinioService` are provided, the original content is written to `{overflowPath}/{timestamp}.txt` and a reference summary is injected instead (implemented as part of ADR-007 integration).

### Compaction reporting

Compaction is communicated to clients in two ways:

1. **Response JSON**: `ChatMessageResponse.compactionReport` is populated when compaction ran during the turn. Includes `strategies`, `activities`, `duration`, and `before`/`after` token snapshots.

2. **SSE stream**: `GET /api/agent/:id/events` streams `AgentEvent` objects (kind `compaction_started`, `compaction_complete`) in real time. The CLI connects to this endpoint after 3 seconds of no response to display progress.

## Decision

- `trimMessages` (Tier 1) as the primary compaction strategy — no LLM cost, handles the common case.
- LangGraph `getState`/`updateState` + `RemoveMessage` to apply compaction to the checkpoint in-place, so the compacted history persists across subsequent turns.
- `LlmConfig.contextWindow` as an optional field (no migration required, JSONB column).
- `AgentEventService` uses an in-memory RxJS Subject per agent — no Redis required while the server runs as a single instance.

## Consequences

- Five new services in `apps/lcp-server/src/context/` and `apps/lcp-server/src/events/`.
- `ChatService.sendMessage()` gains an optional `AbortSignal` parameter; client disconnect aborts the LLM call and returns the agent to `Idle` status.
- `ApiModule` imports `ContextModule` and provides `AgentEventService`.
- Integration tests require the `stub-llm` Docker service (profile `integration`).

## Open questions

**Essential-information anchoring**: The sliding-window and drop strategies risk losing critical early context (decisions made, constraints established, commitments given). A future enhancement: before dropping any message, call the LLM to identify and extract passages tagged as essential, then inject a compact "context anchor" `HumanMessage` preserving those facts. This trades one LLM call per drop batch for much higher fidelity compaction.

A `// TODO` comment marks the drop-messages intervention point in `ContextCompactorService.summariseMessage` until the loss of early context becomes a measurable problem.

**Per-role thresholds**: `TRIGGER_PCT` and `TARGET_PCT` are global constants. Per-role tuning via `LcpRole.runConfig` JSONB is deferred; ponytail comments mark the location in `ContextBudgetService`.
