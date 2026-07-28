# ADR-013: Agent Prompt Assembly and Context Management

Status: Partially Implemented (amended — see [Amendments](#amendments-as-implemented-010282) at the end)

## Context

Each LLM invocation for an TCP agent or chat session requires assembling a prompt from several distinct sources: the role's system-level configuration, the company environment, available services (MCP, RAG), the task or query itself, and any retrieved data. As conversations grow, the combined history will exceed the model's context window unless managed explicitly.

This ADR documents:

1. The intended 8-part prompt structure and its current implementation status.
2. The strategy for managing context window usage over the lifetime of a conversation.
3. Decisions about how compaction activity is reported to clients.

## Prompt structure

The intended prompt for each agent turn consists of eight parts, assembled in order:

| #   | Part                    | Source                                                                                                                                                   | Status         |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 0   | System prompt           | `TcpRole.systemPromptTemplate` (rendered with `name`, `description`, `date`, `companyId`, `roleId`)                                                      | ✅ Implemented |
| 1   | Role prompt             | `TcpRole.rolePrompt` — role identity, attitude, domain knowledge, behavioural guidelines                                                                 | ✅ Implemented |
| 2   | Company environment     | `TcpCompany.companyContext` — company name/description, shared context for all agents                                                                    | ✅ Implemented |
| 3   | Services available      | Dynamic list generated from `role.mcpServerList`; directs agent to call `describe_server`                                                                | ✅ Implemented |
| 4   | Assignment presentation | Mode prompt (`MODE_PROMPTS[assignment.mode]`) + assignment prompt + Materials/Expected lists (see [010.2.4 amendment](#amendments-as-implemented-01024)) | ✅ Implemented |
| 5   | RAG data                | Top-k chunks retrieved via pgvector cosine similarity for the current query                                                                              | ✅ Implemented |
| 6   | MCP responses           | Tool responses pre-fetched before the turn                                                                                                               | ❌ Not yet     |
| 7   | Conversation history    | Maintained implicitly via the LangGraph PostgreSQL checkpoint                                                                                            | ✅ Implemented |
| 8   | Final instruction       | A fixed suffix HumanMessage instructing the agent what to do next                                                                                        | ✅ Implemented |

Part 6 (pre-fetched MCP responses) remains unimplemented; agents call MCP tools reactively via the LangGraph tool node instead.

Part 3 (services available) directs the agent to a server's `describe_server` tool for detail. From 008.6 to 010.2.8, that detail (the server's other tools' full schemas) was only actually bound to the model once `describe_server` had been called, for a bounded number of iterations; that describe-then-reveal gating was removed in 010.2.8.2 — every mode-filtered tool's schema is now bound from turn 1 (see [Amendments](#amendments-as-implemented-010282)).

## Context window management

### Context window size

`LlmConfig.contextWindow` (optional `number`, defaults to `8192`) specifies the model's context window in tokens. Token counting uses the `cl100k_base` tiktoken encoding (bundled via `js-tiktoken`, already a transitive dependency), which is a sufficiently accurate approximation for all currently supported providers.

### Compaction triggers

| Threshold     | Value | Meaning                                                                  |
| ------------- | ----- | ------------------------------------------------------------------------ |
| `TRIGGER_PCT` | 80%   | Compaction is triggered when context exceeds this fraction of the window |
| `TARGET_PCT`  | 60%   | Compaction aims to bring the context below this fraction                 |

These constants are hardcoded in `ContextBudgetService`.

ponytail: move to `TcpRole.runConfig` JSONB when per-role tuning is needed.

### Compaction strategies (in order)

**Tier 1 — fast, no LLM call:**

1. **`trim_messages`**: Uses `trimMessages` from `@langchain/core/messages` with tiktoken token counting. Keeps the system message and the most recent messages up to `TARGET_PCT`. Applied via LangGraph `graph.getState()` + `RemoveMessage` entries in `graph.updateState()`.

**Tier 2 — LLM-assisted, only when Tier 1 is insufficient:**

2. **`summarise_message`**: Oversized individual messages (too large to fit even after trimming) are compressed to bullet-point summaries. Multiple messages are summarised in parallel via `Promise.all`.

3. **`compact_section`**: When prompt sections (role, company env, RAG data, MCP data) are implemented, each will be summarisable in parallel. Deferred until those sections exist.

**Last resort:**

4. **`drop_messages`**: Messages are removed when Tiers 1–3 cannot reach the target. A `// TODO` marks this intervention point for the essential-information-anchoring enhancement (see Open Questions).

### Incoming data guard

Before a new message (or RAG/MCP data) is added to the context, `IncomingDataGuardService` checks whether it would push the total over `TRIGGER_PCT`. If so, it compacts the incoming data using `compact_section` before inclusion. If compacted data still doesn't fit and an overflow path and a `StorageService` (see [ADR-007 amendment](ADR-007-shared-company-storage.md#amendments-as-implemented-0094); `MinioService` prior to 009.4) are provided, the original content is written to `{overflowPath}/{timestamp}.txt` and a reference summary is injected instead (implemented as part of ADR-007 integration).

### Compaction reporting

> **Note (008.6):** the "Response JSON" path below predates [ADR-015](ADR-015-agent-completion-sse.md) (amended) — `ChatMessageResponse`/`compactionReport` on the HTTP response no longer exist; the turn is detached and all output, including compaction activity, streams over SSE. The `completed` terminal event's payload carries the final `compactionReport` instead. See [Amendments](#amendments-as-implemented-0086).

Compaction is communicated to clients in two ways:

1. ~~**Response JSON**: `ChatMessageResponse.compactionReport` is populated when compaction ran during the turn.~~ Superseded — see note above.

2. **SSE stream**: `GET /api/agent/:id/events` streams `AgentEvent` objects (kind `compaction_started`, `compaction_complete`) in real time, alongside every other turn event (LLM activity, reasoning/response deltas, terminal status).

## Decision

- `trimMessages` (Tier 1) as the primary compaction strategy — no LLM cost, handles the common case.
- LangGraph `getState`/`updateState` + `RemoveMessage` to apply compaction to the checkpoint in-place, so the compacted history persists across subsequent turns.
- `LlmConfig.contextWindow` as an optional field (no migration required, JSONB column).
- `AgentEventService` uses an in-memory RxJS Subject per agent, relayed across a Redis channel for events published from tcp-agent — see [ADR-015](ADR-015-agent-completion-sse.md) (amended).

## Consequences

- `ContextBudgetService`, `ContextCompactorService`, `IncomingDataGuardService`, and `ContextManagerService` live in `libs/tcp-shared/src/context/` (moved from `apps/tcp-server/src/context/` in 008.6 so tcp-agent's worker can share them — see [Amendments](#amendments-as-implemented-0086)).
- `ApiModule` imports `ContextModule`, which now wires the shared services' two sink dependencies (`ContextEventSink`, `ContextAuditSink`) to tcp-server's `AgentEventService`/`AuditService`; tcp-agent's `AgentWorkerModule` wires the same services to `AgentEventPublisherService`/`AuditClientService`.
- Integration tests require the `stub-llm` Docker service (profile `integration`).

## Open questions

**Essential-information anchoring**: The sliding-window and drop strategies risk losing critical early context (decisions made, constraints established, commitments given). A future enhancement: before dropping any message, call the LLM to identify and extract passages tagged as essential, then inject a compact "context anchor" `HumanMessage` preserving those facts. This trades one LLM call per drop batch for much higher fidelity compaction. Still deferred as of 008.6 — the per-iteration checking and tool-schema gating added there reduce how often aggressive dropping is reached, making this less urgent in practice, not irrelevant.

A `// TODO` comment marks the drop-messages intervention point in `ContextCompactorService.summariseMessage` until the loss of early context becomes a measurable problem.

**Per-role thresholds**: `TRIGGER_PCT` and `TARGET_PCT` are global constants. Per-role tuning via `TcpRole.runConfig` JSONB is deferred; ponytail comments mark the location in `ContextBudgetService`.

<a id="amendments-as-implemented-0086"></a>

## Amendments as implemented (008.6)

A real end-to-end test (an agent consulting another over a task) surfaced two compounding gaps this ADR's original design didn't account for, both now fixed:

1. **The worker path (`agent-loop.service.ts`'s `runLoop`, i.e. every standard run, resumed run, and consulted-agent run) had zero context-budget coverage.** Only `chat.service.ts`'s inline chat turns ever called `ContextManagerService.prepare()`. Since BullMQ `resume` jobs — including a chat agent's own post-consultation resume — are always handled by the tcp-agent worker, an agent's final segment after a multi-step consultation could accumulate unbounded context with no protection at all. Fixed by relocating the context services to `libs/tcp-shared` and wiring `ContextManagerService` into `AgentLoopService.runLoop` (mirroring chat.service.ts's resolved-window-size pattern).
2. **The budget was checked once per turn/run, not once per iteration.** A long tool-calling run could grow well past the trigger threshold between the initial check and the final response with no further checks. Fixed by extracting a shared `runSupervisedGraph` (`libs/tcp-shared/src/llm/run-supervised-graph.ts`) used by both `chat.service.ts` and `agent-loop.service.ts`: the graph is compiled with `interruptAfterTools: true` (LangGraph deterministically halts after every tool-node execution instead of automatically continuing), and between every such interruption the runner re-checks context budget, tool visibility, and terminal agent status before resuming with a fresh `streamEvents(null, config)` call against the same checkpoint. A budget check also always runs once more when the graph reaches its natural end, in case a tool call moved the agent to a terminal status without leaving the graph itself anything pending.

Also implemented:

- **`ContextBudgetService.countTools(tools)`** — the bound-tools schema LangChain's `bindTools` sends on every request was previously invisible to budget checks (message-content-only counting). Now folded into every "current tokens" calculation.
- **Reactive backstop**: a `try/catch` around each `streamEvents` pass classifies context-length-exceeded errors from the provider (`isContextLengthError`, `libs/tcp-shared/src/llm/context-length-error.ts`) as a defense-in-depth complement to the proactive tiktoken-based check. One compaction attempt is allowed; if the budget is still exceeded (proactively or reactively), the run fails cleanly with `"Context window exceeded even after compaction"` instead of proceeding to a doomed model call.
- **Tool-schema gating (describe-then-reveal), removed in 010.2.8.2 — see that section below.** `ToolVisibilityTracker` kept only each MCP server's own `describe_server` tool bound until the agent called it, at which point that server's other tools became bound for a small number of iterations before being hidden again. The `interactions` server was exempt (its tools are essential control-flow calls that must stay reachable, and it has few enough tools that gating it saved little context anyway). At the time, this was the single biggest lever for supporting models with smaller context windows, since tool-schema overhead (point 1 above) scales with the number of MCP servers loaded — 010.2.8.2 replaced it with static mode-based tool filtering instead.
- **Root cause of the originally reported bug**: a consultation-resolution tool call (or `complete_task`) mutates the agent's DB status, but the LangGraph `tools → agent` edge would still route back to the `agent` node for one more (unwanted, context-length-risking) model call unless something actually stops it. Breaking the event-consumption loop is not enough — it doesn't reliably stop LangGraph's own internal execution. `interruptAfterTools: true` fixes this structurally: the graph cannot proceed past a tool result without the runner explicitly resuming it, so a terminal-status check between iterations reliably prevents the wasted call.

<a id="amendments-as-implemented-0092"></a>

## Amendments as implemented (009.2)

- **`{{date}}` duplication removed**: the identical `new Date().toISOString().split('T')[0]` snippet in `agent-loop.service.ts` and `chat.service.ts` (prompt part 0) is now `buildPromptDateVars(company)` (`libs/tcp-shared/src/llm/prompt-vars.ts`), which also adds `{{datetime}}` (an explicit, human-labeled UTC timestamp — the LLM's authoritative "now"), `{{timezone}}`, and `{{localDatetime}}` (re-rendered via `Intl.DateTimeFormat` against the new `TcpCompany.timezone` field). The UTC anchor is always present; region/local time is additional context, never a replacement.
- **`estimate-context-window` CLI verb** (`tcp-cli`) reuses `ContextBudgetService` to project a role's worst-case initial-prompt token footprint (system prompt + role prompt + company context + services message + task query + RAG estimate) plus `n` further turns, against the resolved LLM's context window — a pre-flight sizing check ahead of the proactive/reactive budget enforcement described above, not a replacement for it. See `docs/tcp-cli.md#estimate-context-window`.

<a id="amendments-as-implemented-01024"></a>

## Amendments as implemented (010.2.4)

- **Prompt part 4 is now the _assignment presentation_, not a bare task prompt.** Every agent carries an `TcpAssignment` (an orphan implement-mode assignment for plain conversations, API-started agents, and consultations; the task's assignment for task work — see [ADR-010](ADR-010-orchestration-design.md)). The agent's mode _is_ its assignment's mode. Part 4 is built from, in order: the mode prompt (`MODE_PROMPTS[assignment.mode]`, `libs/tcp-shared/src/prompts/mode-prompts.ts`); the assignment prompt (already passed through `ContextManagerService.prepare`; omitted when empty, e.g. chat-start); a **Materials** list; and an **Expected outputs** list. For orphans the prompt is exactly the old `agent.initialPrompt`, so existing chat/consultation/agent-start content is preserved (only the mode prompt is added, and Materials/Expected are empty).
- **Prompt-part construction extracted to `apps/tcp-agent/src/agent/prompt-assembly.ts`.** `AgentLoopService.buildInitialState` was an inline monolith; the per-part builders (`renderSystemPrompt`, `buildServicesMessage`, `buildRagMessage`, and the new `buildAssignmentMessage`) are now pure, unit-tested functions there, and `buildInitialState` is a thin composition. Material/expected artifact keys are resolved via `resolveArtifactKey`, moved to `@tcp/shared` (`storage/artifact-keys.ts`, re-exported from tcp-server's `storage-keys.ts`) so tcp-agent can reach it.
- **Modes `plan`/`qa` exist but are not yet dispatched** (parts 5/7). Their mode prompts name `create_plan`/`assure_assignment`; `implement` still names the current `complete_task` (renamed to `complete_assignment` in part 5 — `TODO(010.2.5)`). `requiredToolForMode(mode)` (same module) seeds `TcpAgent.requiredToolCalls` at creation, preserving the prior default `['complete_task']` for implement mode.

<a id="amendments-as-implemented-01028"></a>

## Amendments as implemented (010.2.8)

_2026-07-13._

- **Prompt-assembly moved to `@tcp/shared` and shared by both operation paths.** The pure per-part builders (`renderSystemPrompt`, `buildServicesMessage`, `buildRagMessage`, `buildAssignmentMessage`) now live in `libs/tcp-shared/src/prompts/prompt-assembly.ts` (relocated from `apps/tcp-agent/src/agent/prompt-assembly.ts`). Both `AgentLoopService.buildInitialState` (tcp-agent worker runs) and `ChatService` (tcp-server in-process chat turns) build their first-turn message list from these same builders — the chat path previously duplicated its own `buildServicesMessage`/`buildRagMessage` and rendered a bare user message as part 4. The two tcp-agent-specific fixed strings the builders closed over are now passed in as a `PromptAssemblyStrings` argument (tcp-agent supplies its jsonc-loaded `agentPrompts`; tcp-server supplies its own equivalent set); the MCP `usage` lookup uses the already-shared `MCP_REGISTRY`.
- **The chat path now renders the mode-aware part 4.** A chat agent carries a `chat`-mode orphan assignment (see [ADR-010 010.2.8 amendment](ADR-010-orchestration-design.md#amendments-as-implemented-01028)); `ChatService` renders part 4 via `buildAssignmentMessage` with `MODE_PROMPTS.chat`, so a conversational agent now knows it is in a conversation rather than inferring it from the role prompt. Chat behaviour is otherwise preserved: SSE streaming, per-turn user message on resume turns, RAG overflow-guarding, and returning the agent to `Idle` after each turn (`requiredToolCalls: []` keeps required-tool enforcement out of a chat turn).

<a id="amendments-as-implemented-010282"></a>

## Amendments as implemented (010.2.8.2)

**Describe-then-reveal tool-schema gating (008.6) is removed.** `ToolVisibilityTracker` no longer exists. Every tool a mode is allowed to use is now bound to the model from turn 1, for two reasons found during 010.2.8.2's mode-gating work: the schemas involved are compact enough that the token savings from gating were small, and gating actively hurt weaker models, which would sometimes "forget" a tool existed after it was hidden again. What replaced it is a static, per-mode allow-list rather than a dynamic reveal-on-use mechanism:

- **`@tcp/shared` `mode-tools.ts`** (`MODE_TOOLS`) is the single source of truth for which MCP servers — and, for `storage`, whether the scope is read-only — each mode gets. `filterToolsForMode` applies this to the tool list `McpClientService.loadTools` binds, and the same map drives the server-side storage read-only check, so the client-side filter and the server-side enforcement can't drift apart.
- **Forced tool calls for work modes.** `plan`/`implement`/`qa` now bind with `tool_choice: 'required'`, so a model can't narrate an action instead of calling the tool that performs it.
- **`plan` mode is read-only planning.** It drops the `interactions` server entirely (no consultation or user queries) and gets read-only storage — a planning run can no longer stall waiting on a human, or short-circuit by writing files instead of producing a plan.
- **The `memory` service is skipped for empty-knowledge-base roles** (`AgentRagService.hasKnowledge`), rather than being bound and immediately failing every `recall`/`search_knowledge` call.

This section supersedes the 008.6 tool-schema-gating bullet above and the Part 3 row's earlier description; see also [ADR-010's 010.2.8.2 amendment](ADR-010-orchestration-design.md#amendments-as-implemented-010282), which this work was originally recorded under.
