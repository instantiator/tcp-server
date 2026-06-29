# Glossary

Core terminology for discussing how the LCP system works.

## Services

**lcp-server**
The NestJS REST API service. Hosts all HTTP endpoints, manages entity lifecycle (companies, roles, agents, conversations), enqueues jobs onto BullMQ, and will eventually house the orchestrator.

**lcp-agent**
The agent loop runner service. Consumes jobs from the `agent-jobs` BullMQ queue and executes the LangGraph agent loop for each job.

**lcp-mcp-interactions**
MCP server (port 3012) that lets agents pause for human input (`request_user_input`) or consult another agent by role (`request_agent_consultation`), and signal completion (`complete_task`).

**lcp-mcp-memory**
MCP server (port 3011) that provides agents with access to episodic memory and role knowledge via `recall`, `remember`, and `search_knowledge`.

**lcp-mcp-storage**
MCP server (port 3010) that provides agents with read/write access to the shared MinIO object store (12 tools: list, read, write, delete, restore, search, copy, move, etc.).

**lcp-cli**
Developer CLI tool for interacting with the system: obtaining OIDC tokens, managing companies and roles, starting agents, and responding to open queries.

## Domain entities

**Company (`LcpCompany`)**
A tenant organisation. Owns roles, agents, and a MinIO storage bucket. Carries a `llmDefault` config used by roles that do not specify their own.

**Role (`LcpRole`)**
A named persona within a company (e.g., "Analyst", "Senior Developer"). Defines the system prompt template, LLM config, MCP servers the role can use, and knowledge domains for query routing.

**Agent (`LcpAgent`)**
The canonical unit of work. One agent record is created per run and tracks the full lifecycle from initial prompt to a terminal status (`completed` or `failed`). Carries `status`, `threadId` (for LangGraph checkpoint resumability), and `output`. Informally called a **run** — the two terms are interchangeable.

**Run**
Informal shorthand for an `LcpAgent` record and its full execution lifecycle — everything the agent does from receiving an initial prompt until it reaches a terminal status. A single run may span multiple BullMQ jobs if the agent pauses and resumes.

**Conversation (`Conversation`)**
A pause/reply thread created when an agent calls `request_user_input`. Has a human-readable **slug** (e.g., `analyst-3`) and routes the question to the appropriate company users. Closed when the user replies, which triggers agent resume.

**Consultation (`PendingConsultation`)**
A pause record created when a calling agent requests input from a different role via `request_agent_consultation`. Links the calling agent to the consultation agent; resolved when the consultation agent calls `complete_task`.

**Company user (`CompanyUser`)**
A human user associated with a company. Used for query routing: their `knowledgeDomains` and `roles` fields are matched against questions from agents to determine who receives them.

## Execution concepts

**Agent loop**
The core execution cycle inside lcp-agent: assemble prompt → invoke LLM → invoke tool(s) → repeat until the agent signals completion. Implemented as a LangGraph `StateGraph`.

**BullMQ job**
A queued unit of work dispatched by lcp-server to lcp-agent. Each job carries `{ agentId, type: 'start' | 'resume' }`. A single agent run may be served by multiple jobs if it pauses and resumes.

**Checkpoint**
The persisted LangGraph graph state written to PostgreSQL after each step. Enables the agent loop to resume from exactly where it left off after a pause or restart.

**Thread ID (`threadId`)**
LangGraph's identifier for a checkpoint state thread. Stored on the `LcpAgent` record; used to restore the agent's full conversation history when resuming.

**Pause / Resume**
When an agent calls `request_user_input` or `request_agent_consultation`, its status is set to `paused` and the BullMQ job completes cleanly (no CPU consumed while waiting). On receiving a reply or consultation result, lcp-server re-enqueues the job (`type: 'resume'`) and the agent continues from its checkpoint.

**Task (future)**
A higher-level unit of work managed by the orchestrator, broken into ordered `TaskStep` objects each assigned to a role. Not yet fully implemented; see [ADR-010](ADRs/ADR-010-orchestration-design.md).

**Planner role (future)**
A special role designated per company to generate structured task plans from a task description. Produces a list of `TaskStep` objects that the orchestrator dispatches sequentially.

## Prompt and context

**System prompt template**
The base system message configured on a role. Supports `{{name}}`, `{{description}}`, and `{{date}}` placeholders.

**Prompt parts**
The prompt assembled for each LLM call is composed of up to 8 numbered sections (parts 0–8): system intro, role description, company environment, MCP server list, supplementary context, RAG knowledge, MCP pre-fetched responses, and output instructions. See [ADR-013](ADRs/ADR-013-prompt-assembly-context-management.md).

**Context window**
The token budget for a single LLM invocation. Configured via `LlmConfig.contextWindow`; defaults to 8192.

**Compaction**
Automatic reduction of the assembled prompt when it exceeds the trigger threshold (80% of the context window). Applied in two tiers: sliding-window trim (no LLM call) then LLM summarisation of oversized messages.

**Context overflow**
When data (RAG results, MCP responses) still exceeds the context budget after compaction, the full content is written to MinIO at `{company_slug}/tasks/{agent_id}/context-overflow/{timestamp}.txt` and a compact reference summary is injected in its place.

## LLM and embeddings

**LlmConfig**
The configuration block for an LLM provider: `provider`, `model`, `baseUrl`, `apiKey`, `contextWindow`. Stored as JSONB on a role or as `llmDefault` on a company.

**embeddingConfig**
Configuration for an embedding model. Same shape as `LlmConfig` but points to a model that supports `/v1/embeddings`. Required for RAG; if absent, RAG is silently skipped.

**RAG (Retrieval-Augmented Generation)**
Knowledge relevant to the agent's current task is retrieved from pgvector, ranked by cosine similarity, and injected into prompt part 5 before each LLM call.

**Knowledge chunk (`KnowledgeChunk`)**
An ~800-token slice of a role knowledge document, embedded via the company's `embeddingConfig` and stored in PostgreSQL (pgvector). The unit of RAG retrieval.

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
A list of MCP server names on a role (or task step) specifying which servers the agent can access during its run.

## Storage

**MinIO bucket**
Per-company object storage. All task inputs, outputs, knowledge documents, audit logs, and context overflow are stored under `{company_slug}/` in a single bucket.

**Task materials**
User-supplied inputs placed in `tasks/{task_id}/materials/` before a run starts. Read-only for agents.

**Task output**
The agent's working area at `tasks/{task_id}/output/`. Files written here during a run are candidates for promotion to `finished/` on completion.

## Audit

**Audit event (`AuditEvent`)**
An append-only record of system activity. Types include `llm_request`, `llm_response`, `tool_call`, `tool_result`, `state_change`, and `task_completion_summary`.

**Task completion summary (`LcpTaskCompletionSummary`)**
A structured audit event emitted at the end of a successful run: a brief overall narrative plus tracked lists of actions taken and storage changes (created, modified, deleted, moved files). See [006.5](prompts/006.5%20-%20task%20completion%20planning.md).

## Agent status values

| Status      | Meaning                                              |
| ----------- | ---------------------------------------------------- |
| `idle`      | Created but not yet started                          |
| `running`   | Agent loop is actively executing                     |
| `paused`    | Waiting for user input or a consultation result      |
| `completed` | Run finished successfully; `output` is populated     |
| `failed`    | Run ended with an error; `errorMessage` explains why |
