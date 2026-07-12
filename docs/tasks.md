# Tasks and Assignments

## Overview

A **task** is a piece of work requested by a user. A planner agent turns a
task into a **plan** — an ordered list of implement-mode **assignments**,
each given to an agent of a specific role. There is no separate plan entity:
the plan is simply the task's implement-mode assignments ordered by
`orderIndex`.

Assignments also exist outside any task ("orphan" assignments — plain
conversations/consultations), and in `plan`/`qa` modes (the planner's own
assignment, and QA review assignments). See ADR-010 for the design record;
this document covers the data model shipped in `docs/prompts/010.2.3` — no
orchestration behaviour (planner dispatch, plan execution, QA) is wired yet.
That lands in later parts of the `010.2.x` series (see
`docs/prompts/010.2.0 - task orchestration: overview.md`).

## Entities

### `LcpTask`

| Field           | Type                                   | Notes                                                                    |
| --------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| `companyId`     | uuid                                   | Owning company                                                           |
| `request`       | text                                   | The user's statement of the work                                         |
| `plannerRoleId` | uuid, nullable                         | Explicit planner; falls back to `LcpCompany.plannerRoleId` at start time |
| `status`        | `LcpTaskStatus`                        | See [Task status](#task-status)                                          |
| `materials`     | `LcpMaterialArtifact[]`                | Task materials — `task-materials-path` or `inline-text` only             |
| `expected`      | `LcpTaskCompletedArtifact[]`           | Artifacts the task should produce                                        |
| `completed`     | `LcpTaskCompletedArtifact[]`, nullable | Set at finalisation (part 7)                                             |
| `failureReason` | text, nullable                         | Why the task failed — planner failure, QA exhaustion, etc.               |

### `LcpAssignment`

| Field                | Type                               | Notes                                                                                                        |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `taskId`             | uuid, nullable                     | Null = orphan assignment                                                                                     |
| `companyId`          | uuid                               | Needed directly for orphans                                                                                  |
| `mode`               | `LcpAssignmentMode`                | `plan \| implement \| qa` — the agent's mode IS its assignment's mode; there is no mode column on `LcpAgent` |
| `orderIndex`         | int, nullable                      | Position in the task plan. Set only for implement-mode assignments belonging to a task                       |
| `prompt`             | text                               | Instructions given to the assigned agent                                                                     |
| `roleId`             | uuid                               | The role this assignment must be worked by                                                                   |
| `status`             | `LcpAssignmentStatus`              | See [Assignment status](#assignment-status)                                                                  |
| `agentId`            | uuid, nullable                     | The agent currently/last working this assignment (`ON DELETE SET NULL`)                                      |
| `targetAssignmentId` | uuid, nullable                     | qa-mode only: the assignment under review                                                                    |
| `materials`          | `LcpMaterialArtifact[]`            | Materials supplied to the assignment                                                                         |
| `expected`           | `LcpAssignmentWorkingArtifact[]`   | Artifacts the assignment is expected to produce                                                              |
| `prepared`           | `LcpAssignmentWorkingArtifact[]`   | Set by `complete_assignment` (part 5)                                                                        |
| `approved`           | `LcpAssignmentCompletedArtifact[]` | Set when QA accepts (part 7)                                                                                 |
| `summary`            | text, nullable                     | The completing agent's final answer; becomes the agent's `output` when QA accepts                            |
| `qaStatus`           | `'accepted' \| 'rejected' \| null` | Cleared (with `qaFeedback`) whenever the assignment (re-)enters `in-progress`                                |
| `qaFeedback`         | text, nullable                     |                                                                                                              |
| `qaAttempts`         | int                                | Never reset                                                                                                  |

`orderIndex` is a linear-plan implementation detail — a future DAG-shaped
plan (branch/join) would replace it with an edge list; `selectNextAssignments`
(not yet implemented) is the intended extension point.

### `LcpCompany.plannerRoleId`

Nullable FK to `LcpRole` (`ON DELETE SET NULL`) — the company-wide default
planner role, used when a task does not specify its own `plannerRoleId`.
Must belong to the company it's set on; the API returns `400` otherwise.

## Task status

`LcpTaskStatus`: `ready | planning | in-progress | succeeded | failed | cancelled`.

`planning` is set explicitly when the planner agent is dispatched (`POST
/api/task/:id/start`) and left when `create_plan` lands (`in-progress`) or the
planner fails (`failed`) — part 7. Every other transition is derived from the
task's implement-mode assignments by `deriveTaskStatus`
(`libs/lcp-shared/src/models/task-status.ts`):

1. A terminal `status` (`succeeded | failed | cancelled`) always sticks.
2. Any assignment `failed` → `failed`; else any `cancelled` → `cancelled`.
3. Any assignment `in-progress` or `in-qa` → `in-progress`.
4. At least one assignment and all `succeeded` → `succeeded`.
5. `status === 'planning'` and no assignments yet → stays `planning`.
6. Otherwise → `ready`.

## Assignment status

`LcpAssignmentStatus`: `ready | in-progress | in-qa | succeeded | failed | cancelled`.

A QA rejection returns the assignment from `in-qa` to `in-progress`
(`qaStatus`/`qaFeedback` cleared on that re-entry; `qaAttempts` is never
reset). This part does not implement the QA cycle itself — see
`docs/prompts/010.2.5` and `010.2.7`.

## Artifact model

Artifacts are `{ type, value }` pairs stored in `simple-json` columns —
there is no artifact table. `LcpArtifactType` constrains where an artifact
lives:

| Type                        | Resolves to (via `resolveArtifactKey`)                                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task-materials-path`       | `{companySlug}/tasks/{taskId}/materials/{value}`                                                                                                                        |
| `task-completed-path`       | `{companySlug}/tasks/{taskId}/completed/{value}`                                                                                                                        |
| `assignment-working-path`   | `{companySlug}/tasks/{taskId}/assignments/{orderIndex}/working/{value}` (orphan: `{companySlug}/assignments/{assignmentId}/working/{value}`)                            |
| `assignment-completed-path` | `{companySlug}/tasks/{taskId}/assignments/{orderIndex}/completed/{value}` — `orderIndex` is the **most recent prior** assignment whose `approved` list contains `value` |
| `inline-text`               | Not a storage pointer — literal text. As an expectation, an empty `value` matches any text, otherwise `value` is a regex the text must match                            |

Four union types constrain which artifact types are valid in which field —
see `libs/lcp-shared/src/models/LcpArtifact.ts`:

- `LcpMaterialArtifact` (`LcpTask.materials`, `LcpAssignment.materials`): `task-materials-path | assignment-completed-path | inline-text`
- `LcpAssignmentWorkingArtifact` (`LcpAssignment.expected`, `.prepared`): `assignment-working-path | inline-text`
- `LcpAssignmentCompletedArtifact` (`LcpAssignment.approved`): `assignment-completed-path | inline-text`
- `LcpTaskCompletedArtifact` (`LcpTask.expected`, `.completed`): `task-completed-path | inline-text`

See [Shared Storage](shared-storage.md#folder-structure) for the full
storage tree, including the orphan-assignment working directory.

## REST API

All routes are JWT-guarded. See the Swagger UI (`GET /swagger`) for full
request/response schemas.

| Method & path                  | Purpose                                                                                                                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/task`               | Create a task (`ready` state)                                                                                                                                                                                        |
| `POST /api/task/:id/materials` | Upload a material file (`multipart/form-data`, field `file`); rejected once the task has left `ready` (`409`)                                                                                                        |
| `POST /api/task/:id/start`     | Resolve a planner role (task's own, falling back to the company default — `422` if neither), atomically transition `ready → planning` (`409` if not `ready`), and dispatch the planner (a logged no-op until part 7) |
| `GET /api/task?companyId=`     | List a company's tasks                                                                                                                                                                                               |
| `GET /api/task/:id`            | Get a task with its assignments — plan assignments ordered by `orderIndex`, then the rest by creation time                                                                                                           |

The `start` transition uses an atomic conditional `UPDATE ... WHERE status =
'ready'` (the same pattern as `AgentOrchestrationService.resumeAgent`'s
`pausedAt` claim), so a double `POST /start` can't dispatch the planner twice.

## CLI

```bash
# Create a task, optionally with expected output filenames
./lcp-cli.sh create-task -c acme -r "Write a market analysis report" --expected report.md

# Create, attach materials, and start in one call
./lcp-cli.sh create-task -c acme -r "Summarise the attached brief" \
  -m ./brief.pdf --planner-role planner --start

# List a company's tasks
./lcp-cli.sh list-tasks -c acme

# Get a task and its assignments
./lcp-cli.sh get-task --task-id <uuid>
```

See [lcp-cli.md](lcp-cli.md#create-task) for the full flag reference.
