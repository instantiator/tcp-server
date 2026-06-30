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

## Case: "thinking" models leaving `content` blank

**Symptom:** the agent's response is empty (or, in `lcp-agent`'s case, looks like a silent failure / retried run).

**Cause:** some local reasoning models — observed with `qwen/qwen3.5-9b` served through LM Studio, and known to affect other "thinking" model families (DeepSeek-R1, QwQ, etc.) served through OpenAI-compatible endpoints — put their entire answer into a provider-specific `reasoning_content` field on the chat completion response and leave the standard `content` field empty. This isn't an LLM error; the model did produce an answer, it just landed in the wrong field for callers that only read `content`.

LangChain's OpenAI converter (`@langchain/openai`) doesn't surface `reasoning_content` as `content`, but it does preserve it on `AIMessage.additional_kwargs.reasoning_content`, so the answer is recoverable without touching the raw HTTP response.

**Fix:** [`ReasoningContentRecovery`](../libs/lcp-shared/src/llm/reasoning-content-recovery.ts), called from `buildAgentGraph`'s `agent` node immediately after every model invoke:

- If `content` is non-empty, the message passes through unchanged.
- If `content` is blank and `additional_kwargs.reasoning_content` has text, that text is promoted into `content` and a warning is logged naming the model (from `response_metadata.model_name`).
- If both are blank, the message passes through unchanged — there's nothing to recover.

**Why no model allowlist:** detection is signal-based ("`content` empty, `reasoning_content` populated") rather than a list of known-offending model names. That combination is specific enough on its own to be a reliable signal, and a hardcoded list would only ever cover models already seen — it would fail open for the next thinking model nobody's added to the list yet. The warning log on every recovery gives visibility into which models are doing this over time without needing to maintain a list.

**Interaction with `AgentLoopService`'s empty-content retry:** `runLoop` still has a separate, older safety net — if the _final_ message in a run has blank content after everything else (including this recovery), it retries once with an explicit "Please provide your response." continuation prompt before failing the run. That retry is unconditional (it doesn't know about `reasoning_content`) and exists for the harder case where the model genuinely produced nothing. Because `ReasoningContentRecovery` runs first, inside the graph node, a `reasoning_content` rescue means the retry path is never reached in this scenario — but it still defends against the case where there's truly no recoverable answer.

**Tests:**

- [`reasoning-content-recovery.spec.ts`](../libs/lcp-shared/src/llm/reasoning-content-recovery.spec.ts) — unit tests for the recovery logic itself.
- [`build-agent-graph.spec.ts`](../libs/lcp-shared/src/llm/build-agent-graph.spec.ts) — confirms the recovery actually fires inside a real (non-mocked) LangGraph node.
- [`chat.service.spec.ts`](../apps/lcp-server/src/api/chat.service.spec.ts) — regression test reproducing the exact production scenario this was found in (`lcp-cli chat` against a Qwen model via LM Studio).

---

## Adding a new special case

1. Confirm it's a model/provider quirk, not a bug in our prompt construction or LangChain usage — check the raw HTTP response if possible.
2. If the fix needs to see or modify the model's response, add it as a step inside `buildAgentGraph`'s `agent` node (or a class it calls out to, following `ReasoningContentRecovery`'s pattern), not inside `ChatService` or `AgentLoopService` directly — that keeps it covering both services automatically.
3. Prefer detecting the quirk from its actual signature in the response (an empty field paired with a populated alternate field, a particular error shape, etc.) over an allowlist of model names, for the same reason given above.
4. Add a unit test for the isolated logic and an integration-style test that exercises it through a real (non-mocked) `StateGraph`, matching the pattern in `build-agent-graph.spec.ts`.
5. Document it in this file.
