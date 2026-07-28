# BullMQ Queue

## Overview

Agent execution is asynchronous: tcp-server enqueues jobs on the **`agent-jobs`**
BullMQ queue, and tcp-agent workers consume them. This is the queue this
document is about.

| Role     | Service    | Component                   |
| -------- | ---------- | --------------------------- |
| Producer | tcp-server | `AgentOrchestrationService` |
| Consumer | tcp-agent  | `AgentWorkerService`        |

A second queue, **`knowledge-reindex`**, is internal to tcp-server — both its
producer and its worker live in `KnowledgeReindexService`, so it never crosses
a service boundary. See
[shared-storage.md → Automatic RAG sync](shared-storage.md#automatic-rag-sync-01022).

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

The common path: tcp-server enqueues a `start` job, tcp-agent runs the loop
to completion, and records the output.

```mermaid
sequenceDiagram
    participant S as tcp-server
    participant Q as BullMQ (agent-jobs)
    participant A as tcp-agent

    S->>Q: add job {type: start, agentId}
    Q->>A: deliver job
    A->>A: AgentLoopService.run()
    Note over A: LangGraph runs to completion
    A->>A: complete_assignment called (required — reminded if missed)
    A->>S: POST /internal/assignment/:id/complete (or /internal/agent/:id/fail)
    S->>S: store output, mark Completed (or Failed)
    A-->>Q: job done
```

---

### 2. Agent-to-agent consultation

The calling agent pauses while the called agent runs as a separate job. When
the called agent completes, tcp-server gates the resume on outstanding
requests before re-enqueuing the calling agent.

```mermaid
sequenceDiagram
    participant S as tcp-server
    participant Q as BullMQ (agent-jobs)
    participant Cat as tcp-agent (cat)
    participant Chkn as tcp-agent (chicken)

    S->>Q: add job {type: start, agentId: cat}
    Q->>Cat: deliver job
    Cat->>Cat: LLM calls request_agent_consultation
    Cat->>S: POST /internal/pause
    S->>S: mark cat Paused, create PendingConsultation
    S->>Q: add job {type: start, agentId: chicken}
    Cat-->>Q: job done (cat: Paused)

    Q->>Chkn: deliver job
    Chkn->>Chkn: LangGraph runs, produces answer
    Chkn->>S: complete_assignment → POST /internal/assignment/:id/complete
    S->>S: mark PendingConsultation complete
    Note over S: resumeAgent gate: 0 outstanding
    S->>Q: add job {type: resume, agentId: cat, replyContent}
    Chkn-->>Q: job done

    Q->>Cat: deliver resume job
    Cat->>Cat: LangGraph resumes from checkpoint
    Cat->>Cat: LLM produces final answer
    Cat->>S: complete_assignment → POST /internal/assignment/:id/complete
    S->>S: mark cat Completed
    Cat-->>Q: job done
```

---

### 3. Chat session with consultation

A chat session (triggered by `POST /api/agent/:id/message`) runs LangGraph
**inline** in tcp-server — no BullMQ job for the calling agent's first turn.
The POST returns `202` immediately and the turn streams over the agent's SSE
event stream; when a consultation tool is called, tcp-server dispatches a BullMQ
job for the called agent as normal. Once that job's chain completes, the calling
agent's resumed run finishes and its terminal `completed` event reaches the
client over the same stream — nothing is held open waiting for it. See
[ADR-015](ADRs/ADR-015-agent-completion-sse.md) for the delivery design and
[ADR-012](ADRs/ADR-012-human-in-the-loop.md) for the pause/resume details.

```mermaid
sequenceDiagram
    participant CLI as Client (tcp-cli)
    participant CS as chat.service (tcp-server)
    participant R as Redis (pub/sub)
    participant Q as BullMQ (agent-jobs)
    participant Chkn as tcp-agent (chicken)
    participant Cat2 as tcp-agent (cat resume)

    CLI->>CS: POST /api/agent/:id/message
    CS-->>CLI: 202 Accepted
    CLI->>CS: GET /api/agent/:id/events (SSE, stays open)
    CS->>CS: graph.invoke() — cat LangGraph runs inline
    CS->>CS: LLM calls request_agent_consultation
    CS->>CS: POST /internal/pause (agent: Paused)
    CS->>Q: add job {type: start, agentId: chicken}
    Note over CS: graph.invoke() returns (cat: Paused)

    Q->>Chkn: deliver job
    Chkn->>Chkn: LangGraph runs, produces answer
    Chkn->>CS: complete_assignment → POST /internal/assignment/:id/complete
    CS->>Q: add job {type: resume, agentId: cat}
    Chkn-->>Q: job done

    Q->>Cat2: deliver resume job
    Cat2->>Cat2: LangGraph resumes from checkpoint
    Cat2->>Cat2: LLM produces real answer
    Cat2->>R: PUBLISH agent:events:{catId} (audit + stream events)
    R-->>CS: relayed by AgentEventService
    CS-->>CLI: streamed events, ending with `completed`
```

---

### 4. User-input pause and resume

An agent can pause to ask a human a question. The human replies via the CLI
or API; tcp-server gates the resume on all outstanding requests (same path as
consultation).

```mermaid
sequenceDiagram
    participant User as User (tcp-cli respond)
    participant S as tcp-server
    participant Q as BullMQ (agent-jobs)
    participant A as tcp-agent

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

## Redis pub/sub channels

Redis carries more than the queue. Two unrelated families of channel run
alongside `agent-jobs`, both defined in `@tcp/shared`
(`events/wire-events.ts`, `events/shutdown-channel.ts`):

| Channel                  | Direction              | Carries                                                                                                                |
| ------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `agent:events:{agentId}` | tcp-agent → tcp-server | `WireEvent`s for one agent — persisted audit rows plus live token deltas — relayed onto that agent's SSE stream        |
| `task:events:{taskId}`   | tcp-server → itself    | Task and assignment state changes, relayed onto the task's SSE stream                                                  |
| `company:events:{id}`    | tcp-server → itself    | Company/task state changes, backing the TUI roster's live task list                                                    |
| `tcp:shutdown:command`   | tcp-server → workers   | `drain` \| `force` \| `cancel` (see [ADR-019](ADRs/ADR-019-graceful-shutdown.md))                                      |
| `tcp:shutdown:status`    | workers → tcp-server   | `{ activeAgents }` — the worker's real in-memory count of running loops, which is what lets a drain confirm quiescence |

The earlier `agent:completed:{agentId}` completion signal no longer exists: it
was retired along with the chat long-poll (see
[ADR-015](ADRs/ADR-015-agent-completion-sse.md)), and audit events are now the
single source of truth for both history and live streaming (see
[ADR-008](ADRs/ADR-008-audit-logging.md)).
