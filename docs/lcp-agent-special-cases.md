# Agent Loop Special Cases

Both `lcp-server` (interactive chat — `ChatService`) and `lcp-agent` (autonomous queue runs — `AgentLoopService`) drive a LangGraph agent loop around a chat model. Real LLM providers occasionally misbehave in ways that aren't really bugs in this codebase but still need handling somewhere. This document catalogues those cases and where the workaround lives.

The goal is to keep the workarounds out of the main loop logic in `ChatService`/`AgentLoopService`, so the loop itself stays readable and a future quirk is easy to find: look here first, then in `libs/lcp-shared/src/llm/`.

---

## Shared graph builder as the intervention point

Both services compile their LangGraph `StateGraph` through one shared function, [`buildAgentGraph`](../libs/lcp-shared/src/llm/build-agent-graph.ts). It wires the `agent` node (the LLM invoke) and, when tools are present, a `tools` node with the standard `toolsCondition` routing.

The `agent` node is where each special case below hooks in — it's the one place every model response from either service passes through before it's written to LangGraph's checkpointed conversation history. A fix applied there:

- covers both `lcp-server` chat sessions and `lcp-agent` queue runs in one place
- is reflected in the persisted conversation history, so a later turn in the same thread doesn't see the broken pre-fix message

---

## Case: "thinking" models stopping before they're actually done

**Symptom:** the agent's response is empty, or the agent clearly intended to take an action (consult a role, ask a user, call a tool) but never actually did it — the loop just ends.

**Cause:** some local reasoning models — observed with `qwen/qwen3.5-9b` served through LM Studio, and known to affect other "thinking" model families (DeepSeek-R1, QwQ, etc.) served through OpenAI-compatible endpoints — return a `stop`-terminated completion with `content` blank and the model's entire turn (including, sometimes, a narrated tool call) sitting in a provider-specific `reasoning_content` field instead. Two variants have been observed:

1. **Narrated-but-uninvoked tool call** — `reasoning_content` contains literal `<tool_call>...` text describing the call it intends to make, but the API's `tool_calls` array is empty. The model described the action instead of taking it.
2. **No narrated tool call at all** — `reasoning_content` shows the model still mid-thought (e.g. "let me also check what roles are available...") with no indication it was about to call anything. It just stopped.

Earlier this was treated as "the model finished, and the answer is in `reasoning_content`" — but both production examples above show that's not a safe assumption: the model genuinely wasn't done. Taking `reasoning_content` as a final answer immediately would have shown the user (or the agent loop) a truncated, incomplete response.

**Fix:** [`ReasoningContentRecovery`](../libs/lcp-shared/src/llm/reasoning-content-recovery.ts), called from `buildAgentGraph`'s `agent` node immediately after every model invoke:

- If the response has real `content` or actually populated `tool_calls`, it passes through unchanged — this is the normal case.
- Otherwise the model is presumed not finished. It's re-invoked **once** with the prior (unusable) response plus a corrective nudge appended to the conversation:
  - if `reasoning_content` contains a narrated `<tool_call>`, the nudge tells it to actually invoke the tool rather than describe it
  - otherwise the nudge tells it to continue and either call a tool or give its final response
- Whatever the retried response is, it's used as the recovered result — _if_ it has real content or tool calls.
- If the retry is _also_ unusable, `reasoning_content` from the retried response is promoted into `content` as a last resort, so the loop still gets something rather than nothing.

The nudge round-trip (the original unusable message, and the nudge itself) isn't persisted to checkpointed history — only the final, usable message is returned from the node, keeping the conversation thread clean.

**Why no model allowlist, and why detect `<tool_call>` by literal substring:** detection is signal-based rather than a list of known-offending model names, for the same reason throughout this doc — a list only ever covers models already seen. The `<tool_call>` tag specifically is the literal marker Qwen3.5 emits for this quirk; other models narrating tool calls differently (a different tag, plain prose) won't be caught by this pattern yet. If that's observed, extend the detection regex rather than parsing/executing the narrated call directly — see "Adding a new special case" below for why.

**Why not parse and execute the narrated tool call ourselves:** different models format a narrated call differently, so a parser for arbitrary tool-call-shaped text becomes a growing, fragile maintenance surface, and it'd reimplement argument validation the real tool-calling path already does correctly. Nudging the model to make the call through the proper mechanism is simpler and reuses all the existing tool-call handling.

**Interaction with `AgentLoopService`'s empty-content retry:** `runLoop` still has a separate, older safety net — if the _final_ message in a run has blank content after everything else (including this recovery's one retry), it retries once more with an explicit "Please provide your response." continuation prompt before failing the run. That retry is unconditional and exists for the harder case where the model genuinely produces nothing even after this recovery's own nudge.

**Tests:**

- [`reasoning-content-recovery.spec.ts`](../libs/lcp-shared/src/llm/reasoning-content-recovery.spec.ts) — unit tests for the recovery/nudge/fallback logic, including which nudge wording is chosen.
- [`build-agent-graph.spec.ts`](../libs/lcp-shared/src/llm/build-agent-graph.spec.ts) — confirms the nudge-and-retry actually fires inside a real (non-mocked) LangGraph node and the model is invoked exactly twice.
- [`chat.service.spec.ts`](../apps/lcp-server/src/api/chat.service.spec.ts) — regression test reproducing the original production scenario (`lcp-cli chat` against a Qwen model via LM Studio).

---

## Related: per-run tool visibility isn't a checkpointed loop state

Not a model quirk, but worth knowing when debugging tool-calling behaviour in either service: which MCP tools are currently bound to the model is tracked by `ToolVisibilityTracker` (`libs/lcp-shared/src/llm/tool-visibility-tracker.ts`) in a plain in-memory map, keyed per run/turn — it is **not** part of the LangGraph checkpoint. If a process restarts mid-run, the resumed run starts with only `describe_server` tools visible again, same as a fresh run, rather than remembering what had already been described. This is a deliberate simplification (see [ADR-013 Amendments](ADRs/ADR-013-prompt-assembly-context-management.md#amendments-as-implemented-0086)): re-describing costs one extra tool call, which is cheap compared to adding a new persisted LangGraph state channel for it. If you see a resumed run re-calling `describe_server` for a service it already used before a restart, this is why — it's expected, not a bug.

---

## Adding a new special case

1. Confirm it's a model/provider quirk, not a bug in our prompt construction or LangChain usage — check the raw HTTP response if possible.
2. If the fix needs to see or modify the model's response, add it as a step inside `buildAgentGraph`'s `agent` node (or a class it calls out to, following `ReasoningContentRecovery`'s pattern), not inside `ChatService` or `AgentLoopService` directly — that keeps it covering both services automatically.
3. Prefer detecting the quirk from its actual signature in the response (an empty field paired with a populated alternate field, a particular error shape, etc.) over an allowlist of model names, for the same reason given above.
4. Add a unit test for the isolated logic and an integration-style test that exercises it through a real (non-mocked) `StateGraph`, matching the pattern in `build-agent-graph.spec.ts`.
5. Document it in this file.
