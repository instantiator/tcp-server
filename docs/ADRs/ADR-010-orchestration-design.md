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
- ~~**MCP tool loading (since 008.6):** `McpClientService`'s per-agent-run tool loading (see [agent-services.md](../agent-services.md#enabling-mcp-tools-for-a-role)) is layered with a tool-schema visibility gate — only each server's `describe_server` tool is bound to the model until it's called~~ — **superseded 010.2.8.2**: the gate is removed; all mode-filtered tools are bound from turn 1. The auto-inject/strip-identity behaviour `McpClientService` provides is unaffected. See [ADR-013 Amendments](ADR-013-prompt-assembly-context-management.md#amendments-as-implemented-010282).

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

## Amendments as implemented (010.2.7)

The sequential orchestration flow is now fully wired.
`TaskOrchestrationService` (`apps/lcp-server/src/api/task-orchestration.service.ts`)
is the real `TaskDispatcher` — the abstract `TaskDispatcher` class is now the DI
token, bound to the single `TaskOrchestrationService` instance via `useExisting`.
See [tasks.md § Orchestration flow](../tasks.md#orchestration-flow) for the
behavioural walk-through; the design record:

- **Sequential lifecycle.** planner (`create_plan`) → the lowest-`orderIndex`
  ready implement assignment → QA agent (`assure_assignment`) → accept promotes
  `working/`→`completed/` and advances; reject resumes the implementing agent
  with feedback → next assignment → finalisation (assignment `completed/` files
  copied into the task `completed/`, highest `orderIndex` wins on collision;
  `task.completed` set) → task `succeeded`. Which assignment(s) run next is the
  pure `selectNextAssignments` (`libs/lcp-shared/src/models/task-status.ts`),
  documented as the DAG extension point — it returns a set the orchestrator
  dispatches, so a future branch/join plan changes only that function.
- **Idempotency & races.** Every handler re-reads state and advances it with an
  atomic conditional `UPDATE`; only the status-flip winner runs side effects, so
  duplicate/concurrent hook calls, double-completes, and double-assures are safe.
  Each transition writes an `AuditEventType.StateChange` event.
- **QA role decision (recorded).** The QA agent uses the **same role** as the
  assignment under review — a fresh instance with the domain expertise. A
  dedicated company QA role is future work.
- **QA-attempt cap.** `runConfig.maxQaAttempts`, resolved role → company → env
  `TASK_MAX_QA_ATTEMPTS` → `DEFAULT_TASK_MAX_QA_ATTEMPTS` (3). Exhaustion fails
  the assignment and the task.
- **Failure propagation** is hooked at `POST /internal/agent/:id/fail`: a
  task-linked planner/implement/QA agent failure fails the task. A failed QA
  agent is not retried (fails the target assignment) — re-dispatching QA once is
  the noted upgrade path.
- **Startup recovery.** `reconcileTask` runs for every non-terminal task on
  module init: dead planner → task failed; dead implement agent → failure
  propagated; `in-qa` with no live QA agent → fresh QA dispatched; idle with a
  ready step → dispatched; all succeeded but unfinalised → finalised. Agents
  still `Running`/`Paused` are left to BullMQ + pause/resume.
- **Coverage.** Unit tests over a real in-memory SQLite DB
  (`task-orchestration.service.spec.ts`) plus a no-LLM lifecycle e2e driving the
  internal endpoints against real Postgres/Redis/MinIO
  (`test/e2e/lcp-server/task-orchestration.e2e-spec.ts`). A stub-LLM e2e through
  the real agent loop was deferred — there is no scriptable LLM stub able to
  emit a deterministic multi-agent tool-call sequence (see the plan file's
  implementation notes).
- **Deferred:** task/assignment cancellation, plan revision, and parallel/DAG
  plans.

## Amendments as implemented (010.2.8)

_2026-07-13._

- **`chat` added to the assignment mode set.** `LcpAssignmentMode` is now
  `plan | implement | qa | chat` (a TypeScript union widening only — `mode` is a
  `varchar` column, no migration). `/api/agent/chat/start` creates the agent's
  orphan assignment in `chat` mode (empty prompt); `/api/agent/start` and
  consultations remain `implement`. `requiredToolForMode` now returns a
  `string[]` (the full `requiredToolCalls` list) and returns `[]` for `chat` — a
  chat turn ends with narrated text and has no completion tool. `MODE_PROMPTS.chat`
  states the conversational behaviour explicitly (interact / ground in
  knowledge & storage / consult rather than invent / act via tools / no
  completion tool), so it can be refined over time rather than living implicitly
  in the role prompt.
- **Toward one agent-operation core.** Creation already consolidated onto
  `DbService.createAgent` (010.2.4); this part consolidates prompt assembly onto
  the shared `@lcp/shared` builders across both the chat and worker paths (see
  [ADR-013 010.2.8 amendment](ADR-013-prompt-assembly-context-management.md#amendments-as-implemented-01028)).
  What remains genuinely per-caller (not duplication to remove): the request
  lifecycle vs. the BullMQ job lifecycle/dispatch; idle-between-turns terminal
  semantics (chat returns to `Idle`) vs. run-to-completion (`Completed`/`Paused`/
  `Failed`); and who owns the abort signal. Full extraction of the supervised-run
  spine into a single shared `runAgentTurn` is the noted next step.

## Amendments as implemented (010.2.8.2)

_2026-07-13._

- **Per-mode tool restriction — `plan` mode is read-only planning.** Previously
  every agent got the additive union of registry + company + role MCP servers
  regardless of mode, and only `qa` was constrained (read-only, storage-side). A
  planner therefore had the consultation and file-write tools and could
  short-circuit into consulting another role instead of producing a plan,
  wedging the task in `planning`. New `MODE_DENIED_SERVERS`/`MODE_DENIED_TOOLS`
  (`@lcp/shared` `mode-tools.ts`, only `plan` populated) with `serverNamesForMode`
  / `filterToolsForMode`, applied in `AgentLoopService.runLoop`: a `plan` agent
  is denied the `interactions` server (no agent consultation, no user queries)
  and the mutating storage tools, keeping storage reads, memory, and
  `create_plan`. With no pause vector, the `create_plan` required-tool
  enforcement now always drives a planning run to completion or a clean failure.
- **Runtime plan-completion safety net.** `TaskOrchestrationService.handleAgentCompleted`
  (called from `POST /internal/agent/:id/complete`) fails a task if a `plan`-mode
  agent reaches `Completed` while the task is still `planning` with an empty plan
  — the same `plannerDead` predicate `reconcileTask` uses, now applied at runtime
  rather than only at restart. `resolveRequiredTools` logs at `error` when a mode
  completion tool is missing from the loaded toolset (a wiring bug).
- **Mode prompts reworded** to steer better tool use: invoke tools rather than
  narrate them, use exact tool names (`describe_server` for signatures), and
  right-size output (a short answer is a `summary`/`inline-text`, not a file).
  The consultation prompt suffix is reframed toward a concise inline answer. See
  `010.2.8.2 - task orchestration fixes.md`.
- **Enumerable-value validation feedback.** A shared
  `buildEnumValidationError(purposeOfTool, invalid[])` (`@lcp/shared`) reports
  every invalid enumerable value at once, names the valid values in English, and
  closes with a corrective retry instruction. Applied to `create_plan` (roles +
  artifact types), `complete_assignment` (prepared types), and
  `request_agent_consultation` (target role — the interactions MCP tool now
  relays 4xx corrective messages via `relay4xxOrError`). Plan-mode agents also
  receive the company **role roster** in their initial prompt
  (`buildAvailableRolesMessage`), so they assign steps to real role slugs rather
  than inventing names — found via live testing, where the planner had stopped
  consulting and correctly invoked `create_plan` but with a hallucinated role.
- **`create_plan` ends the planner run.** `create_plan` is the planner's
  completion (as `complete_assignment` is an implementer's): `planTask` now marks
  the plan assignment `succeeded` and completes the planner agent, so its
  supervised loop exits on the next terminal-status check instead of looping to
  `max_iterations`. Prevents a finished planner from hogging the model.
- **Worker concurrency configurable.** `AGENT_WORKER_CONCURRENCY`
  (`DEFAULT_AGENT_WORKER_CONCURRENCY = 5`) replaces the hard-coded value; set to
  `1` when agents share one capacity-limited model (e.g. a single local LLM) so
  parallel runs don't starve each other of model time.
- **Forced tool calls + tools enabled from turn 1.** `buildAgentGraph` forwards
  a mode-aware `toolChoice` to `bindTools`: `'required'` for `plan`/`implement`/
  `qa` (they must end in a tool call — the model can't narrate one instead),
  `'auto'` for `chat`. The **describe-then-reveal tool-schema gating**
  (`ToolVisibilityTracker`, since 008.6) is **removed** — it cost round-trips and
  let the model "forget" a tool after a few iterations; all mode-filtered tools
  are now bound from turn 1 (compact schemas). Supersedes the 008.6 gating in
  [ADR-013](ADR-013-prompt-assembly-context-management.md) and its inline docs
  (agent-services / context-management / lcp-agent-special-cases /
  lcp-mcp-tasks|interactions — full sweep deferred to 010.2.9).
- **No knowledge service for empty-KB roles.** `AgentRagService.hasKnowledge`
  (a cheap `EXISTS` check, no embedding) drops the `memory` server and skips RAG
  retrieval for a role with no indexed chunks.

## Amendments as implemented (010.2.8.3)

_2026-07-14._

- **`finalise` mode — a task-level check that guarantees the task's expected
  outputs.** When the plan (and its QA) completes and the task states `expected`
  outputs, the deliverables are promoted to the task `completed/` directory and a
  `finalise`-mode agent is dispatched over that directory (read-write). It edits,
  renames (`rename_working_file`), or removes files — and may consult another
  role — until the expected outputs are met, then `complete_assignment`. Pass →
  task `succeeded`; the run failing → task `failed` with the files it has still
  promoted. The task is held in a new `finalising` status meanwhile (a sticky
  rule in `deriveTaskStatus`; `recomputeTaskStatus` holds there instead of
  jumping to `succeeded`). Tasks with no `expected` still finalise mechanically.
  `AssignmentService.checkTaskExpectations` is the shape gate; the reaction is
  `TaskOrchestrationService.assignmentFinalised` / the `finalise` branch of
  `handleAgentFailed` / `reconcileTask`.
- **`consultee` mode.** A consultation now runs in a first-class `consultee` mode
  (`MODE_PROMPTS.consultee`) instead of the old `implement` + prompt-suffix hack;
  `pause-and-resume` creates the consultee agent with `mode: 'consultee'`. Same
  completion (`complete_assignment`, orphan assignment).
- **`MODE_TOOLS` (positive) replaces `MODE_DENIED_*`.** `@lcp/shared`
  `mode-tools.ts` now states, per mode, the servers offered and a storage access
  level (`read-write | read-only`) — the single source of truth for both the
  client-side tool filter and the server-side `resolveStorageScope` read-only
  flag (which no longer hard-codes `mode === 'qa'`).
- **`rename_working_file`** storage tool (over the existing
  `StorageService.moveFile`); a read-only-scope refusal is now
  `getReadOnlyMessage(tool, readTools)` (in `storage-prompts.ts`), which names
  the refused tool and the read tools — no mode/dir.
- **Control-char sanitisation (automatic).** `stripControlChars` (`@lcp/shared`)
  removes stray C0 control chars (keeping `\t\n\r`) from model-produced text so
  task/assignment JSON stays valid for strict parsers and terminal-escape
  sequences never reach an operator's console. Applied automatically via TypeORM
  column transformers (`sanitiseTextColumn` / `sanitiseArtifactsColumn`) on the
  model-text columns of `LcpTask`/`LcpAssignment`/`LcpAgent` (`request`,
  `prompt`, `summary`, `qaFeedback`, agent `output`/`initialPrompt`, and every
  artifact-list column's `value`), so every write is sanitised at the DB layer
  with no per-call discipline; `AssignmentService` also strips the `qaFeedback`
  query-builder update path (where transformers don't apply).

## Amendments as implemented (010.3.1)

_2026-07-15._

- **Task cancellation.** `POST /api/task/:id/cancel` (`TaskService.cancel`)
  atomically claims any non-terminal task status → `cancelled` (409 if
  already terminal), then calls the new `TaskDispatcher.cancelTask` hook
  (`TaskOrchestrationService.cancelTask`), which cascades — in order, task →
  assignments → agents — to every still-non-terminal assignment of the task
  (`claimStatus` per row → `cancelled`) and each cancelled assignment's
  working agent (a conditional `UPDATE ... WHERE status NOT IN (completed,
failed, cancelled)`). Every transition is recorded via the existing
  `recordTaskState`/`recordAssignmentState` audit hooks, so the cascade shows
  up in `eavesdrop --show-history`/`--tail` like any other state change.
- **New `AgentStatus.Cancelled`.** The lcp-agent loop's `checkTerminalStatus`
  hook (`agent-loop.service.ts`) now also treats `Cancelled` as terminal: a
  running agent notices on its next status poll (the same DB-read-per-loop-
  iteration mechanism `Paused`/`Completed` already use) and stops cleanly —
  no output write, no `notifyComplete`/`notifyFailed`. `// ponytail:` this
  rides the existing poll rather than a new cross-process abort signal into
  `AgentRegistryService`'s `AbortController`; the upgrade path if
  near-instant interruption is ever needed is to wire a Redis-published abort
  into that registry instead of waiting for the next poll.
- **CLI**: `cancel-task --task-id <uuid>`.
