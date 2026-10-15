# Tasks and Assignments

## Overview

A **task** is a piece of work requested by a user. A planner agent turns a
task into a **plan** — an ordered list of implement-mode **assignments**,
each given to an agent of a specific role. There is no separate plan entity:
the plan is simply the task's implement-mode assignments ordered by
`orderIndex`.

Assignments also exist outside any task ("orphan" assignments — plain
conversations/consultations), and in `plan`/`qa` modes (the planner's own
assignment, and QA review assignments). See ADR-010 for the design record.

The full lifecycle — planner dispatch, plan execution, QA review, file
promotion, finalisation, failure propagation, and startup recovery — is driven
by `TaskOrchestrationService`
(`apps/backend/apps/tcp-server/src/api/task-orchestration.service.ts`), which delegates the
distinct phases to focused collaborators in the same directory:
`TaskStateService` (atomic conditional transitions), `QaVerdictService` (QA
accept/reject consequences), `TaskDeliverablesService` (file promotion and
finalisation), `TaskFailureService` (the paths that end a task badly), and
`TaskRecoveryService` (post-restart repair). See
[Orchestration flow](#orchestration-flow) below.

## Entities

### `TcpTask`

| Field                   | Type                                   | Notes                                                                              |
| ----------------------- | -------------------------------------- | ---------------------------------------------------------------------------------- |
| `companyId`             | uuid                                   | Owning company                                                                     |
| `request`               | text                                   | The user's statement of the work                                                   |
| `plannerRoleId`         | uuid, nullable                         | Explicit planner; falls back to `TcpCompany.plannerRoleId` at start time           |
| `status`                | `TcpTaskStatus`                        | See [Task status](#task-status)                                                    |
| `materials`             | `TcpMaterialArtifact[]`                | Task materials — `task-materials-path` or `inline-text` only                       |
| `expected`              | `TcpTaskCompletedArtifact[]`           | Artifacts the task should produce                                                  |
| `completed`             | `TcpTaskCompletedArtifact[]`, nullable | Set at finalisation (part 7)                                                       |
| `failureReason`         | text, nullable                         | Why the task failed, in plain words. See [Failure reasons](#failure-reasons)       |
| `failureCode`           | text, nullable                         | The `RunFailureCode` behind `failureReason`, when known (001.04)                   |
| `pausedAt`              | timestamp, nullable                    | Set while a user's pause holds the task. See [Pause and resume](#pause-and-resume) |
| `pausedBy`              | text, nullable                         | Who paused it                                                                      |
| `visualisationClosedAt` | timestamp, nullable                    | Set when a user closes a finished task's room in the office view                   |

### `TcpAssignment`

| Field                | Type                               | Notes                                                                                                                                                                                                                                                                              |
| -------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `taskId`             | uuid, nullable                     | Null = orphan assignment                                                                                                                                                                                                                                                           |
| `companyId`          | uuid                               | Needed directly for orphans                                                                                                                                                                                                                                                        |
| `mode`               | `TcpAssignmentMode`                | See [Agent modes](#agent-modes) — the agent's mode IS its assignment's mode; there is no mode column on `TcpAgent`                                                                                                                                                                 |
| `orderIndex`         | int, nullable                      | Position in the task plan. Set only for implement-mode assignments belonging to a task                                                                                                                                                                                             |
| `prompt`             | text                               | Instructions given to the assigned agent                                                                                                                                                                                                                                           |
| `roleId`             | uuid                               | The role this assignment must be worked by                                                                                                                                                                                                                                         |
| `status`             | `TcpAssignmentStatus`              | See [Assignment status](#assignment-status)                                                                                                                                                                                                                                        |
| `agentId`            | uuid, nullable                     | The agent currently/last working this assignment (`ON DELETE SET NULL`)                                                                                                                                                                                                            |
| `targetAssignmentId` | uuid, nullable                     | qa-mode only: the assignment under review                                                                                                                                                                                                                                          |
| `parentAssignmentId` | uuid, nullable                     | The assignment whose agent spawned this one (e.g. a consultation, `ON DELETE SET NULL`) — distinct from `targetAssignmentId` ("who created me", not "what am I evaluating"); when set at creation, `taskId` is inherited from the parent so consultations trace back to their task |
| `materials`          | `TcpMaterialArtifact[]`            | Materials supplied to the assignment                                                                                                                                                                                                                                               |
| `expected`           | `TcpAssignmentWorkingArtifact[]`   | Artifacts the assignment is expected to produce                                                                                                                                                                                                                                    |
| `prepared`           | `TcpAssignmentWorkingArtifact[]`   | Set by `complete_assignment` (part 5)                                                                                                                                                                                                                                              |
| `approved`           | `TcpAssignmentCompletedArtifact[]` | Set when QA accepts (part 7)                                                                                                                                                                                                                                                       |
| `summary`            | text, nullable                     | The completing agent's final answer; becomes the agent's `output` when QA accepts                                                                                                                                                                                                  |
| `qaStatus`           | `'accepted' \| 'rejected' \| null` | Cleared (with `qaFeedback`) whenever the assignment (re-)enters `in-progress`                                                                                                                                                                                                      |
| `qaFeedback`         | text, nullable                     |                                                                                                                                                                                                                                                                                    |
| `qaAttempts`         | int                                | Never reset                                                                                                                                                                                                                                                                        |
| `failureReason`      | text, nullable                     | Why the assignment failed — QA exhaustion, agent run failure, etc. Null unless `status` is `failed`                                                                                                                                                                                |
| `failureCode`        | text, nullable                     | The `RunFailureCode` behind `failureReason`, when known (001.04)                                                                                                                                                                                                                   |

`orderIndex` is a linear-plan implementation detail — a future DAG-shaped
plan (branch/join) would replace it with an edge list; `selectNextAssignments`
(not yet implemented) is the intended extension point.

### `TcpCompany.plannerRoleId`

Nullable FK to `TcpRole` (`ON DELETE SET NULL`) — the company-wide default
planner role, used when a task does not specify its own `plannerRoleId`.
Must belong to the company it's set on; the API returns `400` otherwise.

## Task status

`TcpTaskStatus`: `ready | planning | in-progress | finalising | succeeded | failed | cancelled`.

`planning` is set explicitly when the planner agent is dispatched (`POST
/api/task/:id/start`) and left when `create_plan` lands (`in-progress`) or the
planner fails (`failed`). `finalising` is entered when the plan (and its QA) is
complete but the task states `expected` outputs — a finalise agent must first
bring the deliverables up to them (see [Orchestration flow](#orchestration-flow));
it is left only by the finalise reaction (`succeeded`, or `failed` when finalise
can't meet the expectations — files still promoted). Every other transition is
derived from the task's implement-mode assignments by `deriveTaskStatus`
(`libs/tcp-shared/src/models/task-status.ts`):

1. A terminal `status` (`succeeded | failed | cancelled`) always sticks.
2. `status === 'finalising'` sticks — only the finalise reaction moves it.
3. Any assignment `failed` → `failed`; else any `cancelled` → `cancelled`.
4. Any assignment `in-progress` or `in-qa` → `in-progress`.
5. At least one assignment and all `succeeded` → `succeeded` (held at
   `finalising` by the orchestrator when the task has `expected` outputs).
6. `status === 'planning'` and no assignments yet → stays `planning`.
7. Otherwise → `ready`.

## Assignment status

`TcpAssignmentStatus`: `ready | in-progress | in-qa | succeeded | failed | cancelled`.

A QA rejection returns the assignment from `in-qa` to `in-progress`
(`qaStatus`/`qaFeedback` cleared on that re-entry; `qaAttempts` is never
reset), up to the QA-attempt cap (see [Orchestration flow](#orchestration-flow)).

## Agent modes

`TcpAssignmentMode`: `plan | implement | qa | chat | consultee | finalise`. An
agent's mode **is** its assignment's mode; it drives the prompt
(`modePrompt`), the required completion tool (`requiredToolForMode`), and the
tools offered (`MODE_TOOLS` in `@tcp/shared`). `MODE_TOOLS` is the single source
of truth for both the client-side tool filter and the server-side storage
read-only scope.

The prompt is built from sections, each tied to an MCP server.
`modePrompt(mode, serverNames)` (`libs/tcp-shared/src/prompts/mode-prompts.ts`)
keeps only the sections for servers the agent has, so a role with records
switched off is never told about `query`. See the
[ADR-013 amendment](ADRs/ADR-013-prompt-assembly-context-management.md#amendment-as-implemented-p04-001-02).

| Mode        | Purpose                                                | Servers (all modes also get `utilities`)      | Storage                                  | Records    | Company resources                                         | Required tool           |
| ----------- | ------------------------------------------------------ | --------------------------------------------- | ---------------------------------------- | ---------- | --------------------------------------------------------- | ----------------------- |
| `plan`      | Design a task's plan                                   | tasks, storage, memory, records               | Read-only                                | Read-only  | Read-only                                                 | `create_plan`           |
| `implement` | Carry out one plan step                                | tasks, storage, memory, interactions, records | Read-write                               | Read-write | Writes its own draft                                      | `complete_assignment`   |
| `qa`        | Review a completed step                                | tasks, storage, memory, interactions, records | Read-only, on the step under review      | Read-only  | Read-only; sees the step's drafts                         | `assure_assignment`     |
| `chat`      | Converse with a user                                   | tasks, storage, memory, interactions, records | Read-write                               | Read-write | Writes the live resources directly                        | _none_ (narrated reply) |
| `consultee` | Answer another agent's consultation                    | tasks, storage, memory, interactions, records | Read-write                               | Read-write | Read-only                                                 | `complete_assignment`   |
| `finalise`  | Bring a task's deliverables up to its expected outputs | tasks, storage, memory, interactions, records | Read-write, on the task `completed/` dir | Read-write | Edits the task's pending changes (`completed/resources/`) | `complete_assignment`   |

What each mode does:

- `plan` reads materials and storage to design a plan. It can't consult, query the user, or change anything.
- `implement` produces the step's outputs and may consult other roles. Its result goes to QA.
- `qa` reads the prepared artifacts and accepts or rejects with feedback.
- `chat` is an ongoing conversation. It may consult or act, and returns to `Idle` after each turn.
- `consultee` answers the question concisely in the `summary`, and writes a file only if truly needed. It is an orphan assignment.
- `finalise` edits, renames or deletes deliverables and may consult. It runs after all steps and their QA when the task states `expected` outputs.

`consultee` and `finalise` were added in 010.2.8.3. `plan` and `qa` are storage
and records read-only; the write tools for records are hidden from them on the
agent side. Company resources are read-only in `plan`, `qa` and `consultee`.
Only `plan` drops the `interactions` server (no consultation/user-query, so a
planning run always terminates).

## Artifact model

Artifacts are `{ type, value }` pairs stored in `simple-json` columns —
there is no artifact table. `TcpArtifactType` constrains where an artifact
lives:

| Type                        | Resolves to (via `resolveArtifactKey`)                                                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task-materials-path`       | `{companySlug}/tasks/{taskId}/materials/{value}`                                                                                                                                                         |
| `task-completed-path`       | `{companySlug}/tasks/{taskId}/completed/{value}`                                                                                                                                                         |
| `assignment-working-path`   | `{companySlug}/tasks/{taskId}/assignments/{orderIndex}/working/{value}` (orphan: `{companySlug}/assignments/{assignmentId}/working/{value}`)                                                             |
| `assignment-completed-path` | `{companySlug}/tasks/{taskId}/assignments/{orderIndex}/completed/{value}` — `orderIndex` is the **most recent prior** assignment whose `approved` list contains `value`                                  |
| `inline-text`               | Not a storage pointer — literal text. As an expectation, the `value` describes the answer for the agent and QA; the gate only checks that some non-empty text was given                                  |
| `resource`                  | A company resource: `value` is its path under `resources/` (e.g. `invoices/INV-0042.md`). Resolved through the agent's resource scope, not to one fixed key. See [Company resources](#company-resources) |

Four union types constrain which artifact types are valid in which field —
see `libs/tcp-shared/src/models/TcpArtifact.ts`:

- `TcpMaterialArtifact` (`TcpTask.materials`, `TcpAssignment.materials`): `task-materials-path | assignment-completed-path | resource | inline-text`
- `TcpAssignmentWorkingArtifact` (`TcpAssignment.expected`, `.prepared`): `assignment-working-path | resource | inline-text`
- `TcpAssignmentCompletedArtifact` (`TcpAssignment.approved`): `assignment-completed-path | resource | inline-text`
- `TcpTaskCompletedArtifact` (`TcpTask.expected`, `.completed`): `task-completed-path | resource | inline-text`. A user sets only file and text outputs in `expected`; `completed` records resource changes as `resource` entries.

See [Shared Storage](shared-storage.md#folder-structure) for the full
storage tree, including the orphan-assignment working directory.

### Company resources

A `resource` artifact names a company document by its path under
`{companySlug}/resources/`. It is the one artifact type that is not a pointer
to a single key: where it is read from depends on the agent that asks. See
[Shared Storage → Company resources](shared-storage.md#company-resources) for
the layout and the tools.

- **Expected outputs.** A plan step lists a resource it should create or
  change as `{ "type": "resource", "value": "invoices/INV-0042.md" }` in its
  `expected`. One output can create a new resource or update an existing one.
- **Materials.** A step that should use a resource lists it in `materials` the
  same way. It does not appear in the materials tools. The prompt shows it as
  `- resource: {path}`, and the agent reads it with `read_resource`.
- **Plan validation.** `create_plan` normalises each path and rejects a bad one
  (`..`, an empty path, a trailing `/`). A `resource` material must already
  exist, or be expected by an earlier step; otherwise the plan is refused.
- **Drafts.** In a task, `write_resource` writes a draft into the step's
  `working/resources/`. The output gate checks that each expected resource has
  a draft. It need not be in `prepared`: every draft is promoted.
- **QA.** The QA prompt lists the step's resource drafts, and QA reads them
  with `read_resource`. When QA accepts, **every** file under
  `working/resources/` is promoted to the step's `completed/resources/`, and
  recorded in `approved` as a `resource` entry.
- **Apply.** When the task succeeds, the resource files that gathered in the
  task's `completed/resources/` folder are copied over the live
  `resources/` files. See [Finalisation](#orchestration-flow) below.

A chat agent has no draft step: its resource changes are live at once.

## REST API

All routes are JWT-guarded, and **membership-enforced**: a caller reaches only
companies they are a `CompanyUser` of, whether they name the company directly or
through a task, agent, assignment, role, conversation or storage key. A
non-member gets a `403`, not a filtered result — see
[authentication.md](authentication.md#authorization). See the Swagger UI
(`GET /swagger`) for full request/response schemas.

| Method & path                                                  | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/task`                                               | Create a task (`ready` state)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `PUT /api/task/:id`                                            | Edit `request`/`plannerRoleId`/`materials`/`expected` on an unstarted task (`409` once left `ready`; `404` if `plannerRoleId` doesn't belong to the task's company)                                                                                                                                                                                                                                                                                                                                |
| `POST /api/task/:id/materials`                                 | Upload a material file (`multipart/form-data`, field `file`); rejected once the task has left `ready` (`409`)                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /api/task/:id/start`                                     | Resolve a planner role (task's own, falling back to the company default — `422` if neither), atomically transition `ready → planning` (`409` if not `ready`), and dispatch the planner agent                                                                                                                                                                                                                                                                                                       |
| `POST /api/task/:id/pause`                                     | Pause a running task (`planning`, `in-progress` or `finalising`): see [Pause and resume](#pause-and-resume). `409` if it isn't running or is already paused                                                                                                                                                                                                                                                                                                                                        |
| `POST /api/task/:id/resume`                                    | Lift a user's pause and resume the task's agents paused by it, a spend cap, a shutdown or a rate limit (plus any whose awaited reply has arrived). `503` while shutting down                                                                                                                                                                                                                                                                                                                       |
| `POST /api/task/:id/close-visualisation`                       | Close a finished task's room in the office view (`409` unless the task is `succeeded`, `failed` or `cancelled`)                                                                                                                                                                                                                                                                                                                                                                                    |
| `POST /api/task/:id/cancel`                                    | Transition any non-terminal status → `cancelled` (`409` if already terminal) and cascade to the task's still-non-terminal assignments and their working agents                                                                                                                                                                                                                                                                                                                                     |
| `GET /api/task?companyId=`                                     | List a company's tasks                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET /api/task/:id`                                            | Get a task with its assignments — plan assignments ordered by `orderIndex`, then the rest by creation time — and `waiting`: why it is standing still, or `null` (see [Wait reasons](#wait-reasons))                                                                                                                                                                                                                                                                                                |
| `GET /api/task/:id/history`                                    | Get the task's audit history — its own assignments' agents, including consultations spawned mid-assignment (see [ADR-008](ADRs/ADR-008-audit-logging.md))                                                                                                                                                                                                                                                                                                                                          |
| `GET /api/task/:id/events`                                     | SSE stream of `task_changed`/`assignment_changed` events, primed with current state (see [ADR-015](ADRs/ADR-015-agent-completion-sse.md))                                                                                                                                                                                                                                                                                                                                                          |
| `GET /api/company`                                             | List the caller's companies (`CompanyUser` rows matching the token's `sub` **or** `email`), each with its stat set — `stats.activeAgents`, `stats.tasksByStatus` (zero-filled per status) and `stats.openEnquiries`. `?all=true` returns every company instead — administrators only (`TCP_ADMIN_IDENTIFIERS`), `403` for anyone else (see [ADR-023](ADRs/ADR-023-backend-api-surface-for-the-web-ui.md), [ADR-011](ADRs/ADR-011-authentication-authorization.md#amendments-as-implemented-00205)) |
| `GET /api/company/:id/events`                                  | SSE stream of a company's `state_change` events — `company`, `task`, `agent`, `assignment` and `enquiry` rows — primed with one row per current task, active agent, open consultation and open enquiry (see [ADR-015](ADRs/ADR-015-agent-completion-sse.md), [ADR-023](ADRs/ADR-023-backend-api-surface-for-the-web-ui.md))                                                                                                                                                                        |
| `GET /api/agent?companyId=&roleId=&assignmentId=&status=`      | List agents (default: currently active) — at least one of `companyId`/`roleId`/`assignmentId` required                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET /api/agent/:id/history`                                   | Get an agent's audit history                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `GET /api/assignment?companyId=&taskId=&roleId=&status=&mode=` | List assignments (`taskId=null` for orphans) — at least one of `companyId`/`taskId` required. `?taskId=null&mode=consultee` is the consultations list (see [cross-agent consultations](cross-agent-consultations.md#api-endpoints))                                                                                                                                                                                                                                                                |
| `GET /api/assignment/:id`                                      | Get a single assignment                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

The `start` transition uses an atomic conditional `UPDATE ... WHERE status =
'ready'` (the same pattern as `AgentOrchestrationService.resumeAgent`'s
`pausedAt` claim), so a double `POST /start` can't dispatch the planner twice.
`cancel` uses the equivalent `UPDATE ... WHERE status NOT IN (succeeded,
failed, cancelled)` form, since any non-terminal status is a valid start
point.

## Pause and resume

A user can pause a task that is `planning`, `in-progress` or `finalising`
(`POST /api/task/:id/pause`, the task dialog's **Pause**, or `pause-task`).

- **It is a soft stop.** Running agents stop at their next safe point, after
  the LLM call they are making. Nothing is cut off, so a pause can take as long
  as one call. The task dialog reads "Pausing" until they have stopped.
- **The task records it:** `pausedAt` and `pausedBy`. The task keeps its real
  status. There is no `paused` task status.
- **Agents paused this way have `pauseReason: 'manual'`.** An agent created
  while the task is paused starts paused.
- **Nothing resumes a paused task by itself.** A reply, a consultation result,
  a QA verdict and the spend and rate-limit sweeps are all refused (`409`, or
  skipped) until the task is resumed. A reply that arrives meanwhile is kept
  and given to its agent on resume.
- **A task resume is the only way out** (`POST /api/task/:id/resume`, the
  dialog's **Resume**, or `resume-task`). It clears the pause, then resumes
  the agents paused by it, a spend cap, a shutdown or a rate limit. An agent
  still waiting on an answer stays paused. It exempts the task from spend caps
  only if a cap is reached at that moment, as Start does (see
  [spend-caps.md](spend-caps.md#when-a-cap-is-reached)).
- **A company resume skips a task a user paused.** Resume that task itself.
- **Each resume names the pauses it may lift.** A reply lifts only a wait for
  that reply. This is why a reply can no longer wake an agent paused by a
  spend cap and use the reply up. See
  [ADR-033](ADRs/ADR-033-task-pause-failure-reasons-and-wait-reasons.md).

## Wait reasons

`GET /api/task/:id` returns `waiting`: `null`, or `{ kind, pausedBy?,
resumeAfter? }`. The web client and the CLI's `get-task` show the same thing, in
the same words, from one shared function (`taskWaiting`).

| `kind`         | Means                                                     |
| -------------- | --------------------------------------------------------- |
| `manual`       | A user paused the task (`pausedBy` says who)              |
| `rate_limited` | A provider limit; `resumeAfter` is the next automatic try |
| `spend_cap`    | A spend cap is reached                                    |
| `shutdown`     | The system shut down while the task ran                   |
| `restart`      | The system is restarting; the task carries on by itself   |
| `user_input`   | An agent is waiting for a user's reply                    |
| `consultation` | An agent is waiting for a colleague's answer              |
| `queued`       | An agent is waiting for a model slot                      |

If several apply, the task's own pause wins, then the order above after
`manual`. See [ADR-033](ADRs/ADR-033-task-pause-failure-reasons-and-wait-reasons.md).

## Failure reasons

A failed task's `failureReason` says what went wrong and what to do, in plain
words. The provider's own error text is never shown (it goes to the log). The
reason starts by saying which part stopped: "The planner stopped.", "Step 3
stopped.", "Finishing the task stopped.", or "The review stopped before it
finished." The agent's own reason follows: the provider could not be reached,
the model was not found, the key was rejected, the run ran out of time or
steps, the same call was repeated, and so on. The full list is `RunFailureCode`
in `libs/tcp-shared/src/llm/run-failure.ts`; see
[tcp-agent.md](tcp-agent.md#why-a-run-fails).

A task can fail with no step to blame, for example when recovery or a
recompute finds it failed. It then takes the failed step's reason.

Since 001.04 the reason's **code** is stored too, as `failureCode` on the step
and the task, so tools can tell reasons apart without reading the words. The
web task dialog shows each failed step's reason under it, without expanding
the step, and both reasons reach an open dialog live.

**An agent can fail its own assignment** with `fail_assignment`
([tcp-mcp-tasks.md](tcp-mcp-tasks.md#fail_assignment)), giving one of three
reasons and a sentence the user will read:

| Code                      | When                                                                      |
| ------------------------- | ------------------------------------------------------------------------- |
| `data_protection`         | The work would mean storing data on the company's do-not-store list       |
| `tools_exhausted`         | It tried every approach it could think of and the tools still didn't work |
| `information_unavailable` | Information the task needs can't be found or obtained                     |

A review that rejects a step too many times fails it with `review_exhausted`:
"Step 2 stopped. The work didn't pass review after 3 attempts…".

**A failure that can't be recorded halts the system.** If tcp-agent can't
reach tcp-server after three retries (1s, 5s, 25s), its worker stops taking
jobs. If tcp-server can't save the failure, it logs it, tries an audit row,
and starts a graceful drain flagged `haltedOnError`; every page's banner says
the system stopped itself. An administrator cancels the shutdown or restarts
once the cause is fixed. A failed task can't be run again yet: fix what the reason names, then create a
new task.

## Orchestration flow

`TaskOrchestrationService` is the real dispatcher behind the `TaskDispatcher`
hooks that `TaskService` and `AssignmentService` fire after each validated
state transition. Every handler re-reads current state and advances it with an
atomic conditional `UPDATE`, so it is idempotent under duplicate or concurrent
calls — only the caller that actually flips a status runs the side effects.
Each task and assignment transition is recorded as an
`AuditEventType.StateChange` event.

```text
user creates task ──▶ POST /start ──▶ planner agent (plan mode)
                                          │ create_plan
                                          ▼
   ┌───────────────── implement assignment (lowest ready orderIndex)
   │                      │ complete_assignment  (→ in-qa, agent paused)
   │                      ▼
   │                   QA agent (qa mode, same role)
   │                      │ assure_assignment
   │            ┌─────────┴──────────┐
   │        accept                reject
   │            │                    │
   │   promote working/→completed/   ├─ qaAttempts < cap ─▶ resume implement
   │   assignment succeeded          │                       agent with feedback
   │            │                    └─ qaAttempts ≥ cap  ─▶ assignment failed
   │            ▼                                              → task failed
   └──▶ next ready assignment … or, when all succeed:
                          finalisation ──▶ task succeeded
```

**Planner.** `start` creates a `plan`-mode assignment (carrying the task
request + materials) and dispatches an agent required to call `create_plan`.
`create_plan` validates and writes the ordered implement-mode assignments, then
the first ready one is dispatched.

**Assignment dispatch.** Before an implement assignment runs, its materials are
merged from: the task's own materials, the `assignment-completed-path` outputs
approved by every prior succeeded assignment, and the planner's per-assignment
hints — deduplicated by `(type, value)` (a filename approved by several prior
assignments resolves to the most recent via `resolveArtifactKey`). The
assignment is atomically claimed `ready → in-progress` and an agent required to
call `complete_assignment` is dispatched.

**Which assignment runs next** is chosen by the pure function
`selectNextAssignments` (`libs/tcp-shared/src/models/task-status.ts`): nothing
while any assignment is `in-progress`/`in-qa`, else the single lowest-`orderIndex`
`ready` assignment. This is the **DAG extension point** — a future branch/join
plan replaces the linear `orderIndex` selection here and may return several
assignments at once; the orchestrator already dispatches the return value as a
set.

**QA cycle.** `complete_assignment` moves the assignment to `in-qa` and pauses
its agent; the orchestrator dispatches a QA agent of the **same role** (a fresh
instance with the domain expertise — a dedicated company QA role is future
work) required to call `assure_assignment`.

- **Accept** promotes each prepared `assignment-working-path` file, and every
  resource draft, from the assignment's `working/` directory to its
  `completed/` directory, records the
  `approved` artifacts, transitions `in-qa → succeeded`, completes the paused
  implementing agent (its `summary` becomes the agent output), and advances the
  task.
- **Reject** increments `qaAttempts`. Below the cap, the assignment returns to
  `in-progress` and the paused implementing agent is resumed with the QA
  feedback. At the cap the assignment fails, its agent is failed, and the task
  fails.

**QA-attempt cap.** Resolved per assignment as role → company → env
(`TASK_MAX_QA_ATTEMPTS`) → code default (`DEFAULT_TASK_MAX_QA_ATTEMPTS = 3`),
via `runConfig.maxQaAttempts` and `resolveRunConfig`.

**Finalisation.** When every implement assignment has succeeded, each
assignment's `completed/` files are copied into the task's `completed/`
directory (on a filename collision the highest `orderIndex` wins), `task.completed`
is set (one `task-completed-path` per distinct filename, one `resource` entry
per resource change, plus approved `inline-text` items), and the task becomes
`succeeded`.

Files under `resources/` keep their folders when they are gathered into the
task's `completed/` directory. Other files are flattened to their name.

**Applying resource changes.** Just before the task is marked `succeeded`,
`TaskDeliverablesService.applyResourceChanges` copies each file in the task's
`completed/resources/` over the live file in `{slug}/resources/`. It runs on
both finalise paths: `finaliseMechanical` (a task with no `expected` outputs)
and `assignmentFinalised` (after a finalise agent has run). The finalise
agent's prompt lists the pending changes, and it can fix them with the
resource tools before it completes.

- The task's copy is kept, as the record of what it changed.
- Running apply again is harmless. It writes the same content as a new
  version, so startup recovery can simply run it again.
- If a copy fails part-way, the task **fails**. Its `failureReason` names the
  resource that stopped it and the ones already applied. The finalise agent is
  still completed, because it did its job. The task keeps its `completed`
  record.
- A failed or cancelled task applies nothing.
- Two tasks that change one resource: the later apply wins. The older version
  stays in the bucket's version history (see
  [Shared Storage → Versioning](shared-storage.md#versioning-and-retention)).

**Failure propagation.** A failed agent whose assignment is task-linked fails
the task: a planner failure ("The planner stopped. …"), an implement-agent failure
(assignment `in-progress → failed` → task failed), or a QA-agent failure (the
target assignment fails → task failed; a failed QA agent is not retried).

**Startup recovery.** At application bootstrap, `AgentRecoveryService` first
puts agents right:

- A `running` or `queued` agent with no job in the queue is paused for a
  restart, then resumed from its checkpoint. It is failed as `interrupted`
  instead if its task has ended, or if it was recovered once before.
- Every `restart` pause, left by a restart drain or by the step above, is
  resumed.

Then `TaskRecoveryService.reconcileTask` idempotently repairs every
non-terminal task:

- a `planning` task with no live planner → failed;
- an `in-progress` assignment whose agent died → failure propagated;
- an `in-qa` assignment with no live QA agent → a fresh QA agent dispatched;
- nothing running with a ready step → dispatched;
- all succeeded but not finalised → finalised;
- a `finalising` task whose finalise step succeeded → succeeded, and one with no
  finalise step yet → dispatched.

Agents still `Running` with a job, or `Paused` for any other reason, are left
alone (BullMQ and pause/resume own their recovery). See
[ADR-034](ADRs/ADR-034-restart-and-startup-recovery.md).

## CLI

```bash
# Create a task, optionally with expected output filenames
./tcp-cli.sh create-task -c acme -r "Write a market analysis report" --expected report.md

# Create, attach materials, and start in one call
./tcp-cli.sh create-task -c acme -r "Summarise the attached brief" \
  -m ./brief.pdf --planner-role planner --start

# List a company's tasks
./tcp-cli.sh list-tasks -c acme

# Get a task, its assignments, and why it is waiting
./tcp-cli.sh get-task --task-id <uuid>

# Set a planner role (on a company default, or an unstarted task), edit an
# unstarted task, then start it
./tcp-cli.sh set-planner --company-slug acme --role-slug planner
./tcp-cli.sh set-task --task-id <uuid> -i '{"request":"Write a longer report"}'
./tcp-cli.sh start-task --task-id <uuid>

# Pause a running task, then resume it
./tcp-cli.sh pause-task --task-id <uuid>
./tcp-cli.sh resume-task --task-id <uuid>

# Cancel a task (and its still-running assignments/agents)
./tcp-cli.sh cancel-task --task-id <uuid>

# See what's going on: agents, assignments (including orphans), and history
./tcp-cli.sh list-agents --company acme
./tcp-cli.sh list-assignments --company acme --filter task=null
./tcp-cli.sh eavesdrop --task-id <uuid> --show-history --tail
```

The web task dialog has the same controls: **Start** and **Edit** while the
task is `ready`, **Pause** and **Resume**, and **Cancel**. Closing a finished
task's room is done from the office view's tray, and has no CLI command.

See [tcp-cli.md](tcp-cli.md#create-task) for the full flag reference.
