# Glossary

Core terminology for discussing how the TCP system works.

## Services

**tcp-server**
The NestJS REST API service. Hosts all HTTP endpoints, manages entity lifecycle (companies, roles, agents, tasks, assignments, conversations), owns the task orchestrator, and enqueues jobs onto BullMQ. It also owns all storage access — every other service reaches MinIO through its `/internal/storage/*` endpoints.

**tcp-agent**
The agent loop runner service. Consumes jobs from the `agent-jobs` BullMQ queue and executes the LangGraph agent loop for each job.

**tcp-mcp-interactions**
MCP server (port 3012) that lets agents pause for human input (`request_user_input`) or consult another agent by role (`request_agent_consultation`). Assignment completion moved to the [tcp-mcp-tasks](tcp-mcp-tasks.md) server (`complete_assignment`) in 010.2.5.

**tcp-mcp-memory**
MCP server (port 3011) that provides agents with access to episodic memory and role knowledge via `recall`, `remember`, and `search_knowledge`.

**tcp-mcp-storage**
MCP server (port 3010) giving agents read-only exploration of the shared document store, plus assignment-scoped working-file and material tools. It holds no S3 client — it proxies to tcp-server.

**tcp-mcp-tasks**
MCP server (port 3013) through which an agent completes its assignment: `create_plan`, `complete_assignment`, or `assure_assignment`, gated to the agent's mode.

**tcp-cli**
Developer CLI tool for interacting with the system: obtaining OIDC tokens, managing companies and roles, creating and monitoring tasks, chatting with agents (including a full-screen TUI), responding to open queries, and draining the system for shutdown. See [tcp-cli.md](tcp-cli.md).

## Domain entities

**Company (`TcpCompany`)**
A tenant organisation. Owns roles, agents, and a MinIO storage bucket. Carries a `llmConfig` config used by roles that do not specify their own, an optional company-wide `systemPromptTemplate` default, an additive `mcpServerList`, and a display-only `timezone` (IANA name) used for CLI/UI timestamp presentation and prompt localization — never for storage.

**Role (`TcpRole`)**
A named persona within a company (e.g., "Analyst", "Senior Developer"). Defines the (optional) system prompt template, LLM config, MCP servers the role can use, and knowledge domains for query routing.

**Agent (`TcpAgent`)**
The canonical unit of work. One agent record is created per run and tracks the full lifecycle from initial prompt to a terminal status (`completed` or `failed`). Carries `status`, `threadId` (for LangGraph checkpoint resumability), and `output`. Informally called a **run** — the two terms are interchangeable.

**Run**
Informal shorthand for an `TcpAgent` record and its full execution lifecycle — everything the agent does from receiving an initial prompt until it reaches a terminal status. A single run may span multiple BullMQ jobs if the agent pauses and resumes.

**Conversation (`Conversation`)**
A pause/reply thread created when an agent calls `request_user_input`. Has a human-readable **slug** (e.g., `analyst-3`) and routes the question to the appropriate company users. Closed when the user replies, which triggers agent resume.

**Consultation (`PendingConsultation`)**
A pause record created when a calling agent requests input from a different role via `request_agent_consultation`. Links the calling agent to the consultation agent; resolved as `complete` when the consultation agent calls `complete_assignment`, or as `failed` (with the failure reason) when its run fails — either way the calling agent resumes.

**Company user (`CompanyUser`)**
A human user associated with a company. Used for query routing: their `knowledgeDomains` and `roles` fields are matched against questions from agents to determine who receives them.

## Execution concepts

**Agent loop**
The core execution cycle: assemble prompt → invoke LLM → invoke tool(s) → repeat until the agent signals completion. Implemented as a LangGraph `StateGraph` built by `buildAgentGraph` (`@tcp/shared`) and supervised by `runSupervisedGraph`, which re-checks the context budget and the agent's status at every iteration boundary. Runs in tcp-agent for queued work, and inline in tcp-server for chat turns.

**BullMQ job**
A queued unit of work dispatched by tcp-server to tcp-agent. Each job carries `{ agentId, type: 'start' | 'resume' }`. A single agent run may be served by multiple jobs if it pauses and resumes.

**Checkpoint**
The persisted LangGraph graph state written to PostgreSQL after each step. Enables the agent loop to resume from exactly where it left off after a pause or restart.

**Thread ID (`threadId`)**
LangGraph's identifier for a checkpoint state thread. Stored on the `TcpAgent` record; used to restore the agent's full conversation history when resuming.

**Pause / Resume**
When an agent calls `request_user_input` or `request_agent_consultation`, its status is set to `paused` (with `pausedAt` recorded) and the BullMQ job completes cleanly (no CPU consumed while waiting). The agent only resumes once it has no other outstanding requests; tcp-server then re-enqueues the job (`type: 'resume'`) with every response received since `pausedAt` aggregated into one message. See [cross-agent-consultations.md](cross-agent-consultations.md#resume-conditions).

**Task (`TcpTask`)**
A piece of work requested by a user of a company. Carries the `request`, its `materials`, the `expected` outputs, and a status. A planner agent turns it into a plan; the orchestrator then drives it to `succeeded` or `failed`. See [tasks.md](tasks.md).

**Plan**
Not an entity: a task's plan **is** its implement-mode assignments, ordered by `orderIndex`. Produced by a planner agent calling `create_plan`.

**Assignment (`TcpAssignment`)**
One unit of work given to an agent of a specific role — a plan step, the planner's own assignment, a QA review, a consultation, a finalisation pass, or a plain chat. An assignment with no `taskId` is an **orphan** (a conversation or consultation outside any task).

**Mode (`TcpAssignmentMode`)**
`plan | implement | qa | chat | consultee | finalise`. An agent's mode **is** its assignment's mode. It decides the prompt (`MODE_PROMPTS`), the tools offered (`MODE_TOOLS`), and the tool the agent must call to finish (`requiredToolForMode`). See [tasks.md → Agent modes](tasks.md#agent-modes).

**Planner role**
The role that plans a company's tasks. Resolved per task: the task's own `plannerRoleId`, falling back to the company's. Set with `tcp-cli set-planner`.

**Shortcode**
A task's short, per-company identifier (`000`, `001`, …), assigned at creation and used to label it in the CLI and TUI.

## Prompt and context

**System prompt template**
The base system message rendered for prompt part 0. Resolved with role → company → baked-in default precedence (`SystemPromptTemplateResolver`; a blank template counts as unset). Supports `{{name}}`, `{{description}}`, `{{date}}`, `{{datetime}}`, `{{timezone}}`, `{{localDatetime}}`, `{{companyId}}`, and `{{roleId}}` placeholders — see [`buildPromptDateVars`](../libs/tcp-shared/src/llm/prompt-vars.ts).

**Prompt parts**
The prompt assembled for each LLM call is composed of numbered sections (parts 0–8): system intro, role description, company environment, MCP server list, the assignment presentation, RAG knowledge, pre-fetched MCP responses (part 6 — deferred, not built), and output instructions. Every builder lives in `@tcp/shared`'s `prompt-assembly.ts`, shared by tcp-server's chat path and tcp-agent's worker. See [ADR-013](ADRs/ADR-013-prompt-assembly-context-management.md).

**Context window**
The token budget for a single LLM invocation. Configured via `LlmConfig.contextWindow`; defaults to 8192.

**Compaction**
Automatic reduction of the assembled prompt when it exceeds the trigger threshold (80% of the context window). Applied in two tiers: sliding-window trim (no LLM call) then LLM summarisation of oversized messages. Checked once per tool-calling iteration, not just once per turn. See [context-management.md](context-management.md).

**Context overflow**
When data (RAG results, MCP responses) still exceeds the context budget after compaction, the full content is written to MinIO at `{company_slug}/tasks/{agent_id}/context-overflow/{timestamp}.txt` and a compact reference summary is injected in its place.

## LLM and embeddings

**LlmConfig**
The configuration block for an LLM provider: `provider`, `model`, `baseUrl`, `apiKey`, `contextWindow`. Stored as JSONB `llmConfig` on both a role and a company (both implement `WithLlmConfig`); resolved role → company → environment fallback via `LlmConfigResolver`.

**embeddingConfig**
Configuration for an embedding model. Same shape as `LlmConfig` but points to a model that supports `/v1/embeddings`. Required for RAG; if absent, RAG is silently skipped.

**RAG (Retrieval-Augmented Generation)**
Knowledge relevant to the agent's current task is retrieved from pgvector, ranked by cosine similarity above the role's `runConfig.ragThreshold`, and injected into prompt part 5. The threshold is per-embedding-model, not universal — see [Tuning RAG retrieval](development.md#tuning-rag-retrieval).

**Knowledge chunk (`KnowledgeChunk`)**
An ~800-token slice of a knowledge document, embedded via the company's `embeddingConfig` and stored in PostgreSQL (pgvector). The unit of RAG retrieval. A null `roleId` marks a chunk as company-wide shared knowledge.

**Episodic memory (`EpisodicMemory`)**
Per-agent memories written by the agent via the `remember` MCP tool and retrieved via `recall`. Backed by pgvector; persists across runs.

**OKF (Open Knowledge Format)**
Markdown files with YAML front-matter (at minimum a `title` field) used as the source format for role knowledge documents uploaded for RAG indexing.

## MCP

**MCP (Model Context Protocol)**
The protocol used to expose tools to an LLM agent. Each MCP server exposes tools via `POST /mcp` (Streamable HTTP transport, stateless per-request).

**Tool prefix**
Tools are namespaced as `{serverName}__{toolName}` (e.g., `storage__list_files`) to prevent name collisions across MCP servers.

**mcpServerList**
A list of MCP server names on a role, additive with the company's and the system registry's, specifying which servers are available to the agent. Its mode then narrows that set further (`MODE_TOOLS`).

## Storage

**MinIO bucket**
Per-company object storage. All task inputs, outputs, knowledge documents, audit logs, and context overflow are stored under `{company_slug}/` in a single bucket.

**Task materials**
User-supplied inputs placed in `tasks/{task_id}/materials/` before a task starts. Read-only for agents.

**Working directory**
An assignment's private scratch area — `tasks/{task_id}/assignments/{orderIndex}/working/`, or `assignments/{assignment_id}/working/` for an orphan. The agent supplies only a filename; the prefix is derived server-side from its assignment, so it cannot write outside it.

**Completed directory**
Where approved work lands: an assignment's `completed/` holds the files QA accepted from its `working/`; the task's `completed/` holds the final deliverables gathered from those at finalisation.

**Artifact**
A `{ type, value }` pair naming an input or output — a storage pointer (`task-materials-path`, `assignment-working-path`, `assignment-completed-path`, `task-completed-path`) or literal `inline-text`. There is no artifact table; `resolveArtifactKey` turns a pointer into a storage key. See [tasks.md → Artifact model](tasks.md#artifact-model).

## Audit

**Audit event (`AuditEvent`)**
An append-only record of system activity: `llm_request`, `llm_response`, `tool_call`, `tool_result`, `state_change`, `agent_loop_completion`, `compaction`, `input`, `decision`. Since 010.5.1 these rows are the single source of truth for **both** stored history and the live SSE stream — `AuditService.write` persists a row and then publishes it. See [ADR-008](ADRs/ADR-008-audit-logging.md).

**Agent loop completion summary (`AgentLoopCompletionSummary`)**
The payload of an `agent_loop_completion` event: a brief narrative plus tracked lists of actions taken and storage changes (created, modified, deleted, moved files).

**Wire event (`WireEvent`)**
What crosses an SSE or Redis event stream: either a persisted audit row (`{ type: 'audit', event }`) or a live-only token delta (`StreamDelta`). One shape for three CLI surfaces — `chat`, `tui`, and `eavesdrop` all render through the same library.

## Agent status values

| Status      | Meaning                                                                     |
| ----------- | --------------------------------------------------------------------------- |
| `idle`      | Created but not yet started, or between chat turns                          |
| `running`   | Agent loop is actively executing                                            |
| `queued`    | Waiting for a model slot (see [model-concurrency.md](model-concurrency.md)) |
| `paused`    | Stopped at a resumable point — see `pauseReason` below                      |
| `completed` | Run finished successfully; `output` is populated                            |
| `failed`    | Run ended with an error; `errorMessage` explains why                        |
| `cancelled` | The task or assignment it was working was cancelled                         |

**Pause reason (`TcpAgent.pauseReason`)**
Why a `paused` agent stopped: `user_input`, `consultation`, `shutdown`, `spend_cap`, `rate_limited` or `manual` (a user paused its task). It exists so `resumeAgent`'s "no outstanding requests" gate — which a shutdown-paused agent would otherwise sail straight through — can tell the cases apart, and so each resume lifts only the pauses it owns: a reply lifts `user_input` and `consultation`, never a spend cap or a user's pause. See [ADR-019](ADRs/ADR-019-graceful-shutdown.md), [ADR-032](ADRs/ADR-032-model-concurrency-and-rate-limits.md) and [ADR-033](ADRs/ADR-033-task-pause-failure-reasons-and-wait-reasons.md).

**Task pause (`TcpTask.pausedAt`, `pausedBy`)**
A user's soft stop on a running task. Agents stop after their current step, nothing resumes the task but its own resume, and the task keeps its real status. See [tasks.md](tasks.md#pause-and-resume).

**Wait reason (`taskWaiting`)**
Why a task is standing still: `manual`, `rate_limited`, `spend_cap`, `shutdown`, `user_input`, `consultation` or `queued`. One shared function gives the server, web client and CLI the same answer. See [tasks.md](tasks.md#wait-reasons).

**Failure reason (`RunFailureCode`)**
The typed set behind a failed run's plain-words `failureReason`. See [tcp-agent.md](tcp-agent.md#why-a-run-fails).

## Task and assignment status values

**`TcpTaskStatus`**: `ready | planning | in-progress | finalising | succeeded | failed | cancelled`.

**`TcpAssignmentStatus`**: `ready | in-progress | in-qa | succeeded | failed | cancelled`.

See [tasks.md](tasks.md#task-status) for how each is derived and what moves it.
