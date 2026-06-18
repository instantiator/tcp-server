# ADR-005: Agent State Persistence and Resumability

Status: Proposed

## Context

The spec requires that each agent's current state is captured in the database so that:
- A long-running loop that gets stuck can be **cancelled** by a database change before the service is resumed
- An interrupted loop can be **resumed** from where it left off
- Loops can run for an extended time without risk of total loss if the process crashes

This is in addition to the agent loop framework choice (LangGraph.js — see [ADR-002](./ADR-002-agent-loop-framework.md)) and the database choice (PostgreSQL — see [ADR-004](./ADR-004-database-strategy.md)).

## Decision

**LangGraph PostgreSQL checkpoint store** (`@langchain/langgraph-checkpoint-postgres`).

LangGraph serialises the full graph state (conversation history, pending tool calls, tool results, current node position) to a checkpoint table after every step. This is the natural fit for the spec requirements with no custom implementation needed.

### What is checkpointed

Each checkpoint contains:
- Full message history (all LLM exchanges so far in this step)
- Last tool calls and their results
- Current node in the graph (where to resume)
- The `thread_id` that identifies this specific agent run

### Cancellation

Each task step row in the database has a `status` column. The agent loop checks this column before entering the next graph node:

```
graph node → poll status → if CANCELLED: call interrupt() → exit
```

lcp-server sets `status = 'cancelled'` via the REST API or orchestrator. The next time the agent loop polls (before the next LLM call), it sees the flag and calls `interrupt()`, which suspends the LangGraph run cleanly without mid-message corruption.

### Resume

On lcp-agent restart (or after a cancellation is cleared):
1. lcp-server looks up incomplete task steps in the database
2. It dispatches a BullMQ job with the `thread_id` of the interrupted run
3. lcp-agent re-initialises the LangGraph graph with the same `thread_id` and calls `graph.stream(null, { configurable: { thread_id } })` — LangGraph loads the last checkpoint and continues from where it left off

### Stuck-loop detection

Each task step has a configurable `timeout_seconds` and `max_iterations` value (defaulting to company-level settings). lcp-agent enforces these:
- `max_iterations`: incremented at each graph node; `interrupt()` called if exceeded
- `timeout_seconds`: a timeout wraps the `graph.stream()` call; on expiry, the step is marked `timed_out` and a BullMQ retry is optionally scheduled

## Consequences

- LangGraph checkpoint tables are created automatically by the checkpoint adapter on first run
- The `thread_id` for each agent run is stored in the task step record, linking the relational state to the LangGraph checkpoint
- Unit tests for agent logic mock the checkpoint store; integration tests use a real PostgreSQL instance

## Open Questions / Assumptions

- LangGraph checkpoint schema versioning — if the graph state shape changes between deployments, existing checkpoints may be incompatible. Note: for now, cancelled/failed steps are not resumed across schema-breaking deploys; a migration strategy is a future concern.
