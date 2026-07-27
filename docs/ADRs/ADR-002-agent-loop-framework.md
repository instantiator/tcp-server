# ADR-002: Agent Loop Framework

Status: Partially Implemented (amended — see [Amendment](#amendment-as-implemented-01029) at the end)

## Context

`tcp-agent` needs a framework to run the LLM agent loop: send a prompt, receive a response, invoke tools, handle the tool results, repeat until the agent signals completion. The key requirements from the spec are:

1. **Resumability** — agent state must be checkpointed so a loop can be cancelled and restarted after an interruption (see [ADR-005](./ADR-005-agent-state-persistence.md))
2. **Parallel execution** — multiple agents must be able to run concurrently, including during agent-to-agent consultation
3. **User-in-the-loop** — the loop must be interruptible so the agent can pause and wait for a human response (see [ADR-012](./ADR-012-human-in-the-loop.md))
4. **Pluggable LLM providers** — the loop should not be coupled to a single API provider (see [ADR-003](./ADR-003-llm-provider-abstraction.md))

## Options

| Option                     | Resumability                  | Parallel agents        | User-in-the-loop  | TS support | Notes                                                                                                                                                        |
| -------------------------- | ----------------------------- | ---------------------- | ----------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **DeepAgentsJS**           | ✗ (custom)                    | ✗ (custom)             | ✗ (custom)        | ✓          | LangChain deep-research loop: plan → web-search → write. Not a general-purpose orchestrator. All resumability and parallelism would need to be built on top. |
| **LangGraph.js**           | ✓ (built-in checkpoint store) | ✓ (parallel subgraphs) | ✓ (`interrupt()`) | ✓          | State-machine for agent loops. Part of the LangChain ecosystem. PostgreSQL checkpoint store available out of the box.                                        |
| **Anthropic SDK directly** | ✗ (custom)                    | ✗ (custom)             | ✗ (custom)        | ✓          | ~20-line agent loop. Maximum control; minimal magic. All three requirements above would need custom implementation.                                          |

### Concern: DeepAgentsJS

DeepAgentsJS (`@langchain/langgraph-agent`) is a deep-research agent — its loop is specifically: decompose question → search the web → synthesise answer. It is not a general-purpose tool-use agent framework. Using it for TCP's orchestrated, multi-step task pipeline would require building checkpointing, parallelism, and human-in-the-loop interrupts from scratch on top of it. This is the wrong starting point for these requirements.

## Decision

**LangGraph.js** (`@langchain/langgraph`).

LangGraph models agent execution as a state graph where nodes are actions (call LLM, invoke tool, route) and edges are transitions. Key features used by TCP:

- **PostgreSQL checkpoint store** (`@langchain/langgraph-checkpoint-postgres`): persists the full graph state after every step. Maps directly to the spec requirement: "each agent's current state is captured in the database, so that it can be reconstructed and continued after an interruption." A database `status` flag + `interrupt()` covers cancellation.
- **Parallel subgraphs**: multiple agent loops run as independent subgraph invocations. tcp-agent can run several BullMQ jobs concurrently.
- **`interrupt()`**: suspends the graph mid-step and surfaces a value to the caller. Used for agent-initiated user conversations (see [ADR-012](./ADR-012-human-in-the-loop.md)).
- **LangChain model interface**: pluggable LLM provider via `BaseChatModel` (see [ADR-003](./ADR-003-llm-provider-abstraction.md)).

## Consequences

- LangGraph and its PostgreSQL checkpoint adapter are added as dependencies of tcp-agent
- LangGraph's `StateGraph` is the primary abstraction for defining an agent's behaviour
- LangGraph's event stream is the source for audit log events (see [ADR-008](./ADR-008-audit-logging.md))
- Agent state schema (the graph's `State` type) is defined per role and stored in the role config

## Open Questions / Assumptions

- LangGraph.js is actively maintained by LangChain Inc. as of 2026. Verify dependency health before first use (per `dev-environment/pre-coding-activities.md`).
- A role's graph definition (which tools it has, which nodes are in its loop) is likely static per role type — but the inputs (prompts, context, MCP servers) vary per task step.

## Amendment as implemented (010.2.9)

Two pieces of the Decision above didn't end up matching the built system:

- **`interrupt()` is not used.** Human-in-the-loop pause/resume (agent-initiated user conversations and consultations) is implemented as a BullMQ-based pause/resume — the job simply exits and is re-dispatched later — not LangGraph's native `interrupt()`. See [ADR-012](./ADR-012-human-in-the-loop.md).
- **Multi-agent coordination is implemented, but not as a LangGraph subgraph.** Planner-then-workers coordination (the capability this ADR flagged as future work) is now real: `tcp-server`'s `TaskOrchestrationService` dispatches a planner assignment, then each plan step's implement assignment, then QA, then finalisation, as a plain state machine over `TcpTask`/`TcpAssignment` status columns — not a LangGraph parallel-subgraph construction. Each individual assignment still runs its own single-agent LangGraph loop; the coordination between assignments lives outside LangGraph. See [ADR-010](./ADR-010-orchestration-design.md).

Everything else in the Decision holds: `StateGraph` with the PostgreSQL checkpoint store, parallel subgraph-free concurrent BullMQ jobs, and the pluggable `BaseChatModel` provider interface are all as decided.
