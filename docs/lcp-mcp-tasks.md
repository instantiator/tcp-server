# lcp-mcp-tasks

**Status:** Implemented
**Port:** 3013
**Transport:** MCP Streamable HTTP — stateless, one session per request

`lcp-mcp-tasks` is a NestJS MCP server that lets an agent complete its assignment. Which tool it uses depends on the agent's **mode** (its assignment's mode — there is no separate mode column on `LcpAgent`):

| Mode        | Tool                  | Meaning of "done"                                      |
| ----------- | --------------------- | ------------------------------------------------------ |
| `plan`      | `create_plan`         | Submit the ordered list of assignments for a task      |
| `implement` | `complete_assignment` | Submit finished work (a summary + prepared artifacts)  |
| `qa`        | `assure_assignment`   | Accept, or reject-with-feedback, the work under review |

It lives in `apps/lcp-mcp-tasks/` and runs as a Docker Compose service. Like `lcp-mcp-storage` and `lcp-mcp-interactions`, it is a **thin proxy**: every state transition lives in lcp-server (which owns the DB and `StorageService`) behind `X-Internal-Api-Key`-guarded `/internal/*` endpoints. This service resolves the caller's assignment, mode-gates the tool, and relays validation/gate errors verbatim so the model can correct itself.

Orchestration _reactions_ (dispatching QA agents, resuming after a rejection, copying approved files, advancing the plan) are **task-orchestration part 7** — in this part the endpoints perform the validated state transitions and call an injectable `TaskDispatcher` hook that is still a logged no-op.

See [agent-services.md → MCP Servers](agent-services.md#mcp-servers) for how agents connect, [tasks.md](tasks.md) for the task/assignment model, and [ADR-010](ADRs/ADR-010-orchestration-design.md) / [ADR-012](ADRs/ADR-012-human-in-the-loop.md) for the design.

**`agentId`/`companyId` are not LLM-suppliable.** As with the other MCP servers, `McpClientService` strips `agentId`/`companyId` from the LLM-visible schema and injects the real values on every call. The model never supplies an assignment or task id at all — each tool resolves the caller's assignment from `agentId` server-side (`GET /internal/agent/:agentId/assignment`), so the model cannot act on another agent's assignment.

---

## Tools

| Tool                                          | Signature                                                    | Mode        |
| --------------------------------------------- | ------------------------------------------------------------ | ----------- |
| [`describe_server`](#describe_server)         | `describe_server()`                                          | any         |
| [`create_plan`](#create_plan)                 | `create_plan(agentId, companyId, assignments)`               | `plan`      |
| [`complete_assignment`](#complete_assignment) | `complete_assignment(agentId, companyId, summary, prepared)` | `implement` |
| [`assure_assignment`](#assure_assignment)     | `assure_assignment(agentId, companyId, qa, feedback?)`       | `qa`        |

The three non-`describe_server` tools are **mode-gated**: calling the wrong one for your mode returns a clear error naming the tool you should use instead. All four tools are bound to the model from turn 1 — the describe-then-reveal gating that used to delay the completion tools until after `describe_server` was called was removed in 010.2.8.2 (see [ADR-013 Amendments](ADRs/ADR-013-prompt-assembly-context-management.md#amendments-as-implemented-010282)); which tools a mode gets is now decided entirely by `@lcp/shared` `mode-tools.ts`.

---

## `describe_server`

Returns a markdown overview of the tasks service tailored to the caller's mode. The per-mode instructions are the live `MODE_PROMPTS` texts from `@lcp/shared` (the same text an agent sees in its assignment prompt), embedded here so the tool description and the prompt can never drift.

**Arguments:** none (the injected `agentId`, when present, selects which mode to lead with).

---

## `create_plan`

**Plan mode only.** Submits the plan for the caller's task.

| Parameter     | Type  | Required | Description                                                       |
| ------------- | ----- | -------- | ----------------------------------------------------------------- |
| `assignments` | array | yes      | Ordered `{ prompt, role, expected[], materials? }` — at least one |

Each `expected`/`materials` entry is an `{ type, value }` artifact. Internally, `expected` accepts `assignment-working-path` or `inline-text`; `materials` accepts `task-materials-path`, `assignment-completed-path`, or `inline-text`. The MCP tool schema advertises the shorter LLM-facing names `file`/`text` (`expected`) and `material-file`/`completed-file`/`text` (`materials`), and `canonicalArtifactType` (`libs/lcp-shared/src/models/LcpArtifact.ts`) accepts several near-miss synonyms (`working-file`, `path`, `filename`, `inline`, `string`, …) for all of them, normalising to the internal type before validation.

**Backing endpoint:** `POST /internal/task/:taskId/plan`. Validation (each failure → 4xx with a message the tool relays verbatim): the caller is a `plan`-mode agent whose assignment belongs to `:taskId`; the task is in `planning` (atomically claimed `planning → in-progress`); ≥ 1 assignment; every `role` resolves (id or slug) within the company; artifact types are within the allowed unions. On success it creates the implement-mode `LcpAssignment` rows (`orderIndex` 0…n−1, status `ready`) and calls `TaskDispatcher.taskPlanned` (no-op until part 7).

---

## `complete_assignment`

**Implement mode only.** Submits finished work.

| Parameter  | Type   | Required | Description                                     |
| ---------- | ------ | -------- | ----------------------------------------------- |
| `summary`  | string | yes      | A concise summary of the completed assignment   |
| `prepared` | array  | yes      | `{ type, value }` artifacts prepared for review |

**Backing endpoint:** `POST /internal/assignment/:id/complete`. After confirming the caller is the assignment's agent, in `implement` mode, and the assignment is `in-progress`, the **mechanical gate** runs:

- every `expected` `assignment-working-path` must appear in `prepared` **and** its resolved storage key must exist;
- every `expected` `inline-text` must be matched by a prepared `inline-text` (empty expected value → any; otherwise the expected value is a regex the prepared text must match);
- every prepared `assignment-working-path` must exist in storage.

A gate failure returns **422** with a corrective message listing exactly what is missing — the tool returns this as a normal result (not an exception) so the model can fix and call again. On a gate pass it branches:

- **Orphan assignment** (`taskId === null` — a plain conversation/consultation): `in-progress → succeeded`, and the agent is completed via the same path as `/internal/agent/:id/complete`, so consultations/conversations resolve exactly as they did under the old `complete_task`.
- **Task assignment:** records `prepared`/`summary`, `in-progress → in-qa`, pauses the agent (with `pausedAt`, so part 7 can resume it with QA feedback), calls `TaskDispatcher.assignmentReadyForQa` (no-op), and recomputes the task status via `deriveTaskStatus`.

A duplicate/concurrent completion loses the atomic claim and gets **409**.

---

## `assure_assignment`

**QA mode only.** Records a QA verdict on the assignment under review.

| Parameter  | Type                   | Required          | Description                                                                                       |
| ---------- | ---------------------- | ----------------- | ------------------------------------------------------------------------------------------------- |
| `qa`       | `'accept' \| 'reject'` | yes               | The verdict (case/whitespace-insensitive — `Accept`, `reject`, etc. are folded before validation) |
| `feedback` | string                 | when `qa==reject` | Actionable feedback for the agent                                                                 |

**Backing endpoint:** `POST /internal/assignment/:id/assure`. The caller must be a `qa`-mode agent whose assignment's `targetAssignmentId` is `:id`, and the target must be `in-qa` (atomically claimed via `qaStatus`). `qa` is lower-cased/trimmed by `AssureAssignmentDto` (`@Transform` + `@IsIn`) before validation — the MCP tool layer folds it too, so the local response and audit record match what's stored. It sets `qaStatus`/`qaFeedback`, calls `TaskDispatcher.assignmentAssured` (no-op — part 7 owns the accept/reject consequences), then completes the QA agent (its own assignment → `succeeded`, output = the verdict). A duplicate verdict gets **409**.

---

## Completion enforcement

`LcpAgent.requiredToolCalls` (null → the default for the agent's mode via `requiredToolForMode`; `[]` opts out) lists the tools an agent must invoke before its loop may end. For implement-mode agents the default is `['complete_assignment']`. If the stream ends without them, lcp-agent injects a reminder HumanMessage and re-streams, up to `AGENT_REQUIRED_TOOL_RETRIES` times (default 2). If the calls still haven't succeeded, the run is failed via `POST /internal/agent/:agentId/fail` (resolving any pending consultation as `failed` and resuming the caller). Narrated text is never accepted in place of a required call.

---

## Environment

| Variable           | Default (Docker Compose) | Notes                                  |
| ------------------ | ------------------------ | -------------------------------------- |
| `PORT`             | `3013`                   |                                        |
| `LCP_SERVER_URL`   | `http://lcp-server:3000` | Internal task endpoints live here      |
| `INTERNAL_API_KEY` | —                        | Shared secret for `X-Internal-Api-Key` |
