# BullMQ Queue

## Overview

LCP uses a single BullMQ queue named **`agent-jobs`** backed by Redis. All
agent execution is asynchronous: lcp-server enqueues jobs, lcp-agent workers
consume them.

| Role     | Service    | Component                   |
| -------- | ---------- | --------------------------- |
| Producer | lcp-server | `AgentOrchestrationService` |
| Consumer | lcp-agent  | `AgentWorkerService`        |

## Job types

| `type`   | When dispatched                                               | Payload                                      |
| -------- | ------------------------------------------------------------- | -------------------------------------------- |
| `start`  | New agent created (`AgentOrchestrationService.startAgent`)    | `{ agentId, type: 'start' }`                 |
| `resume` | All outstanding requests resolved (`resumeAgent` gate passes) | `{ agentId, type: 'resume', replyContent? }` |

`replyContent` on a `resume` job is the aggregated text of every consultation
result and user reply received since the agent paused (see
[ADR-012](ADRs/ADR-012-human-in-the-loop.md) for the aggregation logic).

## Use cases

### 1. Standard agent task

The common path: lcp-server enqueues a `start` job, lcp-agent runs the loop
to completion, and records the output.

```mermaid
sequenceDiagram
    participant S as lcp-server
    participant Q as BullMQ (agent-jobs)
    participant A as lcp-agent

    S->>Q: add job {type: start, agentId}
    Q->>A: deliver job
    A->>A: AgentLoopService.run()
    Note over A: LangGraph runs to completion
    A->>A: complete_task called (required; reminded if missed)
    A->>S: POST /internal/agent/:id/complete (or /fail)
    S->>S: store output, mark Completed (or Failed)
    A-->>Q: job done
```

---

### 2. Agent-to-agent consultation

The calling agent pauses while the called agent runs as a separate job. When
the called agent completes, lcp-server gates the resume on outstanding
requests before re-enqueuing the calling agent.

```mermaid
sequenceDiagram
    participant S as lcp-server
    participant Q as BullMQ (agent-jobs)
    participant Cat as lcp-agent (cat)
    participant Chkn as lcp-agent (chicken)

    S->>Q: add job {type: start, agentId: cat}
    Q->>Cat: deliver job
    Cat->>Cat: LLM calls request_agent_consultation
    Cat->>S: POST /internal/pause
    S->>S: mark cat Paused, create PendingConsultation
    S->>Q: add job {type: start, agentId: chicken}
    Cat-->>Q: job done (cat: Paused)

    Q->>Chkn: deliver job
    Chkn->>Chkn: LangGraph runs, produces answer
    Chkn->>S: POST /internal/agent/chicken/complete
    S->>S: mark PendingConsultation complete
    Note over S: resumeAgent gate: 0 outstanding
    S->>Q: add job {type: resume, agentId: cat, replyContent}
    Chkn-->>Q: job done

    Q->>Cat: deliver resume job
    Cat->>Cat: LangGraph resumes from checkpoint
    Cat->>Cat: LLM produces final answer
    Cat->>S: POST /internal/agent/cat/complete
    S->>S: mark cat Completed
    Cat-->>Q: job done
```

---

### 3. Chat session with consultation

A chat session (triggered by `POST /api/agent/:id/message`) runs LangGraph
**inline** in lcp-server — no BullMQ job for the calling agent's first turn.
The POST returns `202` immediately and the turn streams over SSE; when a
consultation tool is called, lcp-server dispatches a BullMQ job for the called
agent as normal. Once that job's chain completes, the calling agent's resumed
run finishes and lcp-server emits the terminal `completed` event to the client's
SSE stream.

> **Note:** the sequence diagram below predates [ADR-015](ADRs/ADR-015-agent-completion-sse.md)
> (amended) — the `SUBSCRIBE agent:completed` / "HTTP held open" long-poll it
> shows was replaced by the `202` + SSE flow. Steps are otherwise unchanged. See
> [ADR-012](ADRs/ADR-012-human-in-the-loop.md) for the pause/resume details.

```mermaid
sequenceDiagram
    participant CLI as Client (lcp-cli)
    participant CS as chat.service (lcp-server)
    participant R as Redis
    participant Q as BullMQ (agent-jobs)
    participant Chkn as lcp-agent (chicken)
    participant Cat2 as lcp-agent (cat resume)

    CLI->>CS: POST /api/agent/:id/message
    CS->>CS: graph.invoke() — cat LangGraph runs inline
    CS->>CS: LLM calls request_agent_consultation
    CS->>CS: POST /internal/pause (agent: Paused)
    CS->>Q: add job {type: start, agentId: chicken}
    Note over CS: graph.invoke() returns (cat: Paused)
    CS->>R: SUBSCRIBE agent:completed:{catId}
    Note over CS: HTTP held open

    Q->>Chkn: deliver job
    Chkn->>Chkn: LangGraph runs, produces answer
    Chkn->>CS: POST /internal/agent/chicken/complete
    CS->>Q: add job {type: resume, agentId: cat}
    Chkn-->>Q: job done

    Q->>Cat2: deliver resume job
    Cat2->>Cat2: LangGraph resumes from checkpoint
    Cat2->>Cat2: LLM produces real answer
    Cat2->>R: PUBLISH agent:completed:{catId}
    R-->>CS: event received
    CS->>R: UNSUBSCRIBE
    CS-->>CLI: real answer from cat agent
    Cat2->>CS: POST /internal/agent/cat/complete
    Cat2-->>Q: job done
```

---

### 4. User-input pause and resume

An agent can pause to ask a human a question. The human replies via the CLI
or API; lcp-server gates the resume on all outstanding requests (same path as
consultation).

```mermaid
sequenceDiagram
    participant User as User (lcp-cli respond)
    participant S as lcp-server
    participant Q as BullMQ (agent-jobs)
    participant A as lcp-agent

    S->>Q: add job {type: start, agentId}
    Q->>A: deliver job
    A->>A: LLM calls request_user_input
    A->>S: POST /internal/pause
    S->>S: mark agent Paused, create Conversation
    A-->>Q: job done (agent: Paused)

    User->>S: POST /api/conversation/:slug/reply
    S->>S: close Conversation, store reply
    Note over S: resumeAgent gate: 0 outstanding
    S->>Q: add job {type: resume, agentId, replyContent}

    Q->>A: deliver resume job
    A->>A: LangGraph resumes with user reply
    A->>A: LLM produces final answer
    A->>S: POST /internal/agent/:id/complete
    A-->>Q: job done
```

## Resume gating

`AgentOrchestrationService.resumeAgent` is the single choke point for all
resume paths (consultation complete, user reply). Before dispatching a
`resume` job it counts outstanding `PendingConsultation` rows with
`status = 'pending'` and `Conversation` rows with `status = 'awaiting_user'`
for the agent. The job is only dispatched when both counts are zero, ensuring
the agent sees every answer it asked for in a single resumed run rather than
resuming prematurely on the first response to arrive.

## Redis pub/sub channel

In addition to job routing, Redis carries a lightweight completion signal:

| Channel                     | Published by                   | Consumed by                |
| --------------------------- | ------------------------------ | -------------------------- |
| `agent:completed:{agentId}` | `AgentLoopService` (lcp-agent) | `ChatService` (lcp-server) |

This channel is only relevant for **chat sessions** (use case 3). Standard
BullMQ agent runs (use cases 1, 2, 4) do not depend on it — if no one
subscribes, the message goes nowhere harmlessly.
