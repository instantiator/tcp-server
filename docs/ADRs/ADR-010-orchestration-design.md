# ADR-010: Orchestration Design

Status: Proposed

## Context

The orchestration layer is the long-running service (within lcp-server) that manages the full lifecycle of a task: from the initial user prompt, through plan generation and agent dispatch, to completion. It is the "delivery manager" of LCP.

Key requirements:

- Generate a task plan using a configurable "planner role" agent
- Dispatch task steps to lcp-agent one at a time (or in parallel where the plan allows)
- Support agent-to-agent consultation mid-step
- Allow agents and users to revise the plan
- Resume incomplete tasks on service restart
- Keep the database as the source of truth at every stage

## Task lifecycle

```
created → planning → in_progress → reviewing → completed
                                              → failed
                                              → cancelled
```

- **created**: user has submitted the task via API; supporting materials uploaded to MinIO
- **planning**: orchestrator dispatches to the planner role agent; plan is being generated
- **in_progress**: plan exists; steps are being executed by assigned role agents
- **reviewing**: final step (if a review step is in the plan) is in progress
- **completed / failed / cancelled**: terminal states

## Task plan structure

A task plan is a list of steps stored in the database. Each step:

```typescript
interface TaskStep {
  id: UUID;
  task_id: UUID;
  order: number;
  role: string; // which role definition to use
  knowledge_domains: string[]; // used to pre-fetch relevant memories/KB
  mcp_server_list: McpServerConfig[]; // step-specific MCP additions
  input_context: string; // summary of what to pass to this agent
  output_spec: string; // what the agent is expected to produce
  status: StepStatus;
  thread_id?: string; // LangGraph checkpoint thread ID (set on dispatch)
  result?: string; // agent's output summary
  timeout_seconds: number;
  max_iterations: number;
}
```

## Role definition schema

Roles are stored in the company config. Full schema (from design session):

```typescript
interface RoleDefinition {
  name: string;
  description: string;
  knowledge_domains: string[];
  knowledge_base: {
    storage_path: string; // MinIO path to OKF source files
    vector_namespace: string; // pgvector namespace for this role's KB
  };
  memory_namespace: string; // pgvector namespace for episodic memory
  mcp_server_list: McpServerConfig[];
  llm_config: LlmConfig; // see ADR-003
  system_prompt_template: string;
}
```

## Planner role

Each company config specifies a `planner_role` — the role that generates task plans. A typical choice is a "product owner" or "delivery manager" role. When a task enters `planning`:

1. The orchestrator constructs a prompt from the task description and supporting materials
2. It dispatches a single-step plan-generation job to lcp-agent using the planner role's config
3. The planner agent produces a structured task plan (list of `TaskStep` objects)
4. The orchestrator validates and stores the plan, then transitions the task to `in_progress`

Supporting materials (uploaded by the user at task creation) are accessible to the planner agent via the storage MCP server.

## Task queue

**BullMQ + Redis** (see [ADR-009](./ADR-009-containerization-strategy.md) for why Redis is in Docker Compose).

| Queue           | Direction              | Description                               |
| --------------- | ---------------------- | ----------------------------------------- |
| `agent-jobs`    | lcp-server → lcp-agent | Dispatches a task step for execution      |
| `agent-results` | lcp-agent → lcp-server | Reports step completion, progress, events |

BullMQ's retry and priority features are used: failed steps are retried up to a configurable limit; high-priority tasks can preempt lower-priority ones.

> **Note (008.6):** `AgentWorkerService`'s duplicate-job guard (`AgentRegistryService.isRunning`) had a TOCTOU race — it checked `isRunning` before `AgentLoopService.run` registered the agent, with an `await` (a DB fetch) in between. A stalled-job retry (BullMQ re-dispatching a job whose lock renewal failed — the default 30s lock duration is far shorter than a single turn can take with a slow local model) could slip through that gap and start a second concurrent execution against the same LangGraph checkpoint thread, producing repeated `complete_task` calls, stray extra model turns, and incorrect "task not complete" reminders even though the task had genuinely completed. Fixed by moving registration into the worker's job processor itself, synchronously with the `isRunning` check (no `await` in between), and raising the BullMQ lock duration to 5 minutes as a second line of defence. See `agent-worker.service.ts` and `agent-worker.service.spec.ts`'s atomicity regression test.

### Orchestrator loop (lcp-server)

The orchestrator is a NestJS service that:

1. On startup: scans for tasks in `planning` or `in_progress` with no active job — resumes them
2. On `agent-results` event `step_completed`: advances the plan to the next step, or marks the task `completed`
3. On `agent-results` event `step_failed`: increments retry count; marks task `failed` on limit
4. On `agent-results` event `consult`: pauses current step, dispatches a consultation job, resumes original step with result
5. On `agent-results` event `revise_plan`: validates proposed changes and patches the plan
6. On `agent-results` event `request_user_input`: suspends step (see [ADR-012](./ADR-012-human-in-the-loop.md)), creates a conversation thread

## Agent-to-agent consultation

When an agent needs to consult another role (e.g., the developer asks the security consultant for a review):

1. Agent emits a `consult` event with: target role name, question, relevant context
2. Orchestrator records the consultation request, pauses the current step
3. Dispatches a consultation job to lcp-agent (short-lived agent run for the consultant role)
4. On completion, orchestrator injects the consultant's response into the original step's context and resumes it

## Plan revision

An agent can propose plan revisions via a `revise_plan` event containing the proposed changes. The orchestrator:

1. Validates the proposed changes (no removal of completed steps, no circular dependencies)
2. Applies the patch to the plan in the database
3. Resumes the current step

## Example task flow

Task: "Add a secure login feature to the webapp"

```
planning:    [product-owner]   → generates plan
in_progress: [architect]       → designs the approach
in_progress: [security-consultant] → reviews the design (consultation triggered by architect)
in_progress: [senior-developer]    → specifies the implementation task
in_progress: [developer]           → implements the work
reviewing:   [senior-developer]    → reviews and tests the change
completed
```

## Restore on restart

On lcp-server startup:

1. Query all tasks with status `planning` or `in_progress`
2. For each incomplete step with no active BullMQ job: re-dispatch
3. LangGraph checkpoints ensure lcp-agent resumes from the last safe state (see [ADR-005](./ADR-005-agent-state-persistence.md))

## Consequences

- The orchestrator is a NestJS service within lcp-server — no new deployable
- BullMQ workers run within lcp-agent; the queue is the only coupling between lcp-server and lcp-agent
- All task and plan state lives in PostgreSQL; Redis is ephemeral (queue transport only)
- **MCP tool loading (since 008.6):** `McpClientService`'s per-agent-run tool loading (see [agent-services.md](../agent-services.md#enabling-mcp-tools-for-a-role)) is layered with a tool-schema visibility gate — only each server's `describe_server` tool is bound to the model until it's called, sitting alongside the existing auto-inject/strip-identity behaviour `McpClientService` already provides. See [ADR-013 Amendments](ADR-013-prompt-assembly-context-management.md#amendments-as-implemented-0086).

## Open Questions / Assumptions

- Parallel task steps: the current design is sequential. Parallel steps (where the plan specifies no dependency between them) are a future extension — the BullMQ dispatch logic and plan data model support it but the orchestrator loop handles sequential first.
- Dead-letter queue for permanently failed jobs: note for implementation

## Amendments as implemented (010.2.3)

The drafted `TaskStep` (JSONB steps embedded in a task config) is superseded
by two entities and a small set of REST/CLI surfaces. No orchestration
behaviour (planner dispatch, plan execution, QA) is implemented yet — this
amendment covers the data layer only. Full details: [tasks.md](../tasks.md).

- **`LcpTask`** (replaces the `created → planning → in_progress → reviewing →
completed` lifecycle sketch): `status` is
  `ready | planning | in-progress | succeeded | failed | cancelled`, derived
  from its assignments by `deriveTaskStatus` except `planning` (set
  explicitly on dispatch) and the terminal states.
- **`LcpAssignment`** (replaces `TaskStep`): `taskId` nullable (null = an
  "orphan" assignment — a plain conversation/consultation outside any task);
  `mode` (`plan | implement | qa`) is the agent's mode — there is no `mode`
  column on `LcpAgent`, it derives its mode via its assignment (added in
  part 4). A task's plan is its implement-mode assignments ordered by
  `orderIndex`; there is no separate plan entity.
- **Artifact model**: no artifact table — `{ type, value }` pairs in
  `simple-json` columns, constrained by four TypeScript union types
  (`LcpMaterialArtifact`, `LcpAssignmentWorkingArtifact`,
  `LcpAssignmentCompletedArtifact`, `LcpTaskCompletedArtifact`). Storage keys
  extend the ADR-007 layout with `tasks/{id}/assignments/{orderIndex}/{working,completed}/`
  and an orphan `assignments/{id}/working/` directory.
- **`LcpCompany.plannerRoleId`**: company-wide default planner role, used
  when a task doesn't specify its own.
- **REST/CLI**: `POST /api/task` (create), `POST /api/task/:id/materials`
  (upload), `POST /api/task/:id/start` (atomic `ready → planning` + a logged
  no-op planner dispatch, replaced in part 7), `GET /api/task`, `GET
/api/task/:id`; CLI verbs `create-task`/`list-tasks`/`get-task`.

Still outstanding: the planner role agent, multi-step plan execution, the QA
review cycle, and task/assignment cancellation — tracked across the
remaining `010.2.x` sub-plans.

## Amendments as implemented (010.2.4)

- **Every `LcpAgent` now carries an assignment** (`assignmentId`, non-nullable
  FK, `ON DELETE CASCADE`). Task work uses the task's assignment; plain
  conversations, API-started agents (`/api/agent/start`, `/api/agent/chat/start`),
  and consultations get an auto-created **orphan** implement-mode assignment
  (`taskId: null`, `status: in-progress`, prompt copied from the agent's
  `initialPrompt`). `DbService.createAgent` creates the orphan and cross-links
  it (agent → assignment, assignment.agentId → agent) in one transaction. The
  agent's mode is its assignment's mode; there is no mode column on `LcpAgent`.
  The destructive `AddAgentAssignment` migration deletes all existing
  `lcp_agent` rows (a non-nullable FK cannot be backfilled). See the
  [ADR-013 010.2.4 amendment](ADR-013-prompt-assembly-context-management.md#amendments-as-implemented-01024)
  for how the assignment drives prompt part 4.
- `plan`/`qa` modes exist but nothing dispatches them yet (parts 5/7).

## Amendments as implemented (010.2.5)

- **Plan creation is now a tool**, not a drafted internal call. A `plan`-mode
  agent turns its task into a plan via `create_plan` on the new
  [lcp-mcp-tasks](../lcp-mcp-tasks.md) MCP server (port 3013), which proxies
  `POST /internal/task/:taskId/plan`. The endpoint validates the caller
  (plan mode, assignment belongs to the task), atomically claims the task
  `planning → in-progress`, and creates the ordered implement-mode
  `LcpAssignment` rows (`orderIndex` 0…n−1, status `ready`). The reaction that
  actually dispatches the first assignment is part 7 — here `TaskDispatcher`
  exposes `taskPlanned`/`assignmentReadyForQa`/`assignmentAssured` hooks that are
  logged no-ops.
- **The state transitions backing the three mode tools** (`create_plan`,
  `complete_assignment`, `assure_assignment`) live in `AssignmentService` on
  lcp-server, guarded by `InternalApiKeyGuard`. Each uses an atomic conditional
  `UPDATE` (the `pausedAt` claim pattern) so double/concurrent calls resolve to
  one winner; the loser gets a `409`. The MCP server holds no state — it
  resolves the caller's assignment (`GET /internal/agent/:id/assignment`),
  mode-gates the tool, and relays validation/gate errors verbatim.
