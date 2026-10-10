# tcp-cli — Developer CLI Reference

`tcp-cli` is a TypeScript command-line tool for interacting with an TCP server.
It lives in `apps/backend/apps/tcp-cli/` and is launched via `./tcp-cli.sh` at the repository root.

## Quick start

```bash
# Build and run (auto-builds on first call)
./tcp-cli.sh --help

# Force rebuild before running
./tcp-cli.sh --rebuild list-companies
```

## Global options

These options apply to all verbs and must come before the verb name.

| Flag                           | Alias | Default                 | Description                                    |
| ------------------------------ | ----- | ----------------------- | ---------------------------------------------- |
| `--tcp-server <url>`           | `-s`  | `http://localhost:3000` | TCP server base URL                            |
| `--access-token <token>`       | `-t`  | —                       | Bearer token (skips auth flow)                 |
| `--refresh-token <token>`      | `-T`  | —                       | Refresh token (renews an expired access token) |
| `--access-token-env-var <var>` | `-E`  | —                       | Name of env var holding the token              |

**Token resolution order**: `-t` → `-E` → `TCP_TOKEN` env var (if set) → OAuth 2.0
device-authorization login (opens a browser). The `TCP_TOKEN` fallback is silent when
unset — it just falls through to the next step — but an explicit `-E <var>` whose var
is unset is a hard error, since that was asked for by name.

> [!NOTE]
> The alias is capital `-E`, not `-e` — lowercase `-e` is already claimed by
> `./tcp-cli.sh`'s own wrapper flag, `-e, --env <file>` (loads a different env
> file before running). `-E` does not collide with it.

**Token renewal**: when `-t` or `-E` is used alongside `-T`, the refresh token is held in memory. Commands that run for a long time (e.g. `chat`) automatically exchange it for a new access token when the server returns `401 Unauthorized`, then retry the request transparently. When device-flow login is used instead, the server's own refresh token from that login is used — no `-T` is needed.

## Authentication

tcp-cli needs a valid OIDC access token for most operations.
The OIDC provider (Zitadel) doesn't support a password grant, so login goes
through the OAuth 2.0 Device Authorization Grant (RFC 8628) — the same
pattern `gh auth login` / `docker login` use. `get-token` prints a
verification URL and code; open it in a browser, complete login, and the CLI
prints the resulting access token to stdout once you're done.

```bash
# Prints a verification URL + code to stderr, then polls until you finish
# logging in in a browser, then prints the access token to stdout
./tcp-cli.sh get-token

# Capture it into TCP_TOKEN — every subsequent command picks it up
# automatically, no --access-token-env-var needed
export TCP_TOKEN=$(./tcp-cli.sh get-token)
./tcp-cli.sh list-companies
```

Use `--access-token-env-var <var>`/`-E` instead if you'd rather use a differently-named
variable (e.g. to keep multiple tokens around for different servers).

## Validating JSON input

`set-company`, `set-role`, and similar commands accept a JSON payload. Before applying, validate it against the generated JSON Schema to catch missing required fields or type mismatches before they reach the server:

```bash
# Install ajv-cli once (global, not in devDependencies)
npm install -g ajv-cli

# Validate a company file
ajv validate -s schemas/schema.json --ref '#/definitions/TcpCompany' -d my-company.json

# Validate a role file
ajv validate -s schemas/schema.json --ref '#/definitions/TcpRole' -d my-role.json
```

See [schema.md](schema.md) for the full field reference, VS Code integration, example JSON, and an inline Node.js validation option that needs no extra install.

## Verbs

| Verb                                                        | Invocation                                                                                                          | Description                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [`get-token`](#get-token)                                   | `get-token`                                                                                                         | Sign in via the browser (device-flow login) and print an OIDC access token                    |
| [`list-companies`](#list-companies)                         | `list-companies`                                                                                                    | List all companies                                                                            |
| [`list-roles`](#list-roles)                                 | `list-roles [-c <uuid>\|--company-slug <slug>]`                                                                     | List roles, optionally filtered to one company                                                |
| [`set-company`](#set-company)                               | `set-company [-c <uuid>\|--company-slug <slug>] [-i <json>]`                                                        | Create or update a company                                                                    |
| [`set-role`](#set-role)                                     | `set-role [-c <uuid>\|--company-slug <slug>] [-r <uuid>\|--role-slug <slug>] [-i <json>]`                           | Create or update a role                                                                       |
| [`delete-company`](#delete-company)                         | `delete-company (-c <uuid>\|--company-slug <slug>) [-f]`                                                            | Delete a company and everything in it                                                         |
| [`delete-role`](#delete-role)                               | `delete-role (-r <uuid>\|--role-slug <slug>) [-f]`                                                                  | Delete a role and everything tied to it                                                       |
| [`chat`](#chat)                                             | `chat (-r <uuid>\|--role-slug <slug>) [-q <message>]`                                                               | Interactive or single-query chat with a role                                                  |
| [`tui`](#tui)                                               | `tui (-c <uuid>\|--company-slug <slug>)`                                                                            | Open the full-screen TUI on a company's roster (no role required)                             |
| [`list-knowledge`](#list-knowledge)                         | `list-knowledge (--role <slug-or-id>\|--company <slug-or-id>)`                                                      | List knowledge-base documents for a role or company (shared knowledge)                        |
| [`get-knowledge`](#get-knowledge)                           | `get-knowledge (--role <slug-or-id>\|--company <slug-or-id>) -f <filename> [-o <path>]`                             | Get a knowledge-base document's content                                                       |
| [`store-knowledge`](#store-knowledge)                       | `store-knowledge (--role <slug-or-id>\|--company <slug-or-id>) -s <path> [-t <filename>]`                           | Upload a document to a role or company knowledge base (converted to OKF Markdown server-side) |
| [`delete-knowledge`](#delete-knowledge)                     | `delete-knowledge (--role <slug-or-id>\|--company <slug-or-id>) -f <filename>`                                      | Delete a knowledge-base document by filename                                                  |
| [`reindex-knowledge`](#reindex-knowledge)                   | `reindex-knowledge --company <slug-or-id>`                                                                          | Force a full RAG rebuild of every knowledge scope of a company                                |
| [`get-knowledge-index-status`](#get-knowledge-index-status) | `get-knowledge-index-status (--role <slug-or-id>\|--company <slug-or-id>)`                                          | Report knowledge-index status for a role, or a company's shared scope plus every role         |
| [`query-knowledge`](#query-knowledge)                       | `query-knowledge --role <slug-or-id> -q <text> [--top-k <n>] [--threshold <n>]`                                     | Query the RAG index for a role, without invoking any LLM call                                 |
| [`open-document-store`](#open-document-store)               | `open-document-store [--no-open]`                                                                                   | Print (and open) the MinIO console URL                                                        |
| [`open-swagger`](#open-swagger)                             | `open-swagger --service <name> [--no-open]`                                                                         | Print (and open) a service's Swagger UI URL                                                   |
| [`list-open-queries`](#list-open-queries)                   | `list-open-queries [-c <uuid>\|--company-slug <slug>] [--format table\|json\|csv]`                                  | List open agent-to-human queries                                                              |
| [`read-query`](#read-query)                                 | `read-query <slug>`                                                                                                 | Read a query's full question and conversation history                                         |
| [`respond`](#respond)                                       | `respond <slug> <message>`                                                                                          | Reply to a query and resume the waiting agent                                                 |
| [`download-shared-document`](#download-shared-document)     | `download-shared-document --source <path> [--target <path>]`                                                        | Download a file from shared company storage                                                   |
| [`upload-shared-document`](#upload-shared-document)         | `upload-shared-document --source <path> --target <path>`                                                            | Upload a local file to shared company storage                                                 |
| [`estimate-context-window`](#estimate-context-window)       | `estimate-context-window [-c <uuid>\|--company-slug <slug>] [-r <uuid>\|--role-slug <slug>]`                        | Estimate a role's worst-case prompt token footprint                                           |
| [`validate-shared-document`](#validate-shared-document)     | `validate-shared-document --path <path\|glob> [--recursive]`                                                        | Re-validate document(s) already in shared storage                                             |
| [`create-task`](#create-task)                               | `create-task -c <slug-or-id> -r <text> [--planner-role <slug-or-id>] [-m <paths...>] [-e <filenames...>] [--start]` | Create a task, optionally uploading materials and starting it                                 |
| [`list-tasks`](#list-tasks)                                 | `list-tasks -c <slug-or-id>`                                                                                        | List a company's tasks                                                                        |
| [`get-task`](#get-task)                                     | `get-task --task-id <uuid>`                                                                                         | Get a task, including its assignment statuses and QA outcomes                                 |
| [`set-task`](#set-task)                                     | `set-task --task-id <uuid> [-i <json>]`                                                                             | Edit an unstarted task's request, planner, materials or expected outputs                      |
| [`set-planner`](#set-planner)                               | `set-planner (--company <slug-or-id> \| --task-id <uuid>) --role <slug-or-id>`                                      | Set a company's default planner role, or an unstarted task's                                  |
| [`start-task`](#start-task)                                 | `start-task --task-id <uuid>`                                                                                       | Start a task that was created earlier                                                         |
| [`pause-task`](#pause-task)                                 | `pause-task --task-id <uuid>`                                                                                       | Pause a running task until `resume-task`                                                      |
| [`cancel-task`](#cancel-task)                               | `cancel-task --task-id <uuid>`                                                                                      | Cancel a task and its still-non-terminal assignments/agents                                   |
| [`list-agents`](#list-agents)                               | `list-agents (--role \| --company <slug-or-id>) [--filter k=v...]`                                                  | List agents for a role or company                                                             |
| [`list-assignments`](#list-assignments)                     | `list-assignments (--task-id <uuid> \| --company <slug-or-id>) [--filter k=v...]`                                   | List assignments for a task or company                                                        |
| [`eavesdrop`](#eavesdrop)                                   | `eavesdrop (--agent-id \| --assignment-id \| --task-id <uuid>) [--show-history] [--tail]`                           | Replay and/or follow an agent's, assignment's, or task's activity                             |
| [`shutdown`](#shutdown)                                     | `shutdown [--force] [--no-stop] [--timeout <seconds>]`                                                              | Drain the system for shutdown, wait for agents to pause, then stop the containers             |
| [`restart`](#restart)                                       | `restart [--force] [--timeout <seconds>]`                                                                           | Drain the system, then restart tcp-server and tcp-agent; paused work carries on by itself     |
| [`cancel-shutdown`](#cancel-shutdown)                       | `cancel-shutdown`                                                                                                   | Cancel a shutdown or restart in progress                                                      |
| [`get-health`](#get-health)                                 | `get-health [--app <name>]`                                                                                         | Show the health of every service                                                              |
| [`usage`](#usage)                                           | `usage [--company-id <id-or-slug>]`                                                                                 | Report spend caps, usage and totals                                                           |
| [`notifications`](#notifications)                           | `notifications [--all] [--company-id <uuid>]`                                                                       | List notifications (a company's own with `--company-id`)                                      |
| [`dismiss-notification`](#dismiss-notification)             | `dismiss-notification --notification-id <uuid>`                                                                     | Dismiss a notification                                                                        |
| [`dismiss-cap`](#dismiss-cap)                               | `dismiss-cap --provider <id> [--indefinitely]`                                                                      | Lift a provider's spend cap (administrators only)                                             |
| [`restore-cap`](#restore-cap)                               | `restore-cap --provider <id>`                                                                                       | Restore a provider's spend cap (administrators only)                                          |
| [`resume-task`](#resume-task)                               | `resume-task --task-id <uuid>`                                                                                      | Resume a paused task (`pause-task`, spend cap, shutdown or rate limit)                        |
| [`resume-company`](#resume-company)                         | `resume-company --company-id <id-or-slug>`                                                                          | Resume a company's tasks paused by a spend cap or shutdown                                    |

### Entity identifiers: `--x`, `--x-id`, `--x-slug`

Every verb that takes a role or company accepts all three forms for that
entity, and they compose the same way everywhere:

- `--role <slug-or-id>` / `--company <slug-or-id>` — a single combined value.
  Looks like a UUID → treated as an id (no extra lookup); otherwise treated
  as a slug.
- `--role-id <uuid>` / `--company-id <uuid>` — always an id, used as-is.
- `--role-slug <slug>` / `--company-slug <slug>` — always a slug.

Pass at most one variant per entity. A role slug (from `--role-slug`, or a
non-UUID `--role`) additionally requires a company (`--company`/
`--company-id`/`--company-slug`) to disambiguate — role slugs are unique only
within a company, not globally. A role UUID (from `--role-id`, or a
UUID-shaped `--role`) already implies its company, so pairing it with a
company flag is redundant (rejected on `chat`, harmlessly ignored elsewhere).

### `get-token`

Sign in via the browser (device-flow login) and print an OIDC access token.

- **stdout**: the raw access token string
- **stderr**: the verification URL/code to open in a browser

```bash
./tcp-cli.sh get-token
```

A common usage is to place the token into `TCP_TOKEN` for future work:

```bash
export TCP_TOKEN=$(./tcp-cli.sh get-token)
```

> [!NOTE]
> A user sign in will be required only if the token has expired or not present. An existing and in-date token will be used. To force regeneration, use the `--force` option.

### `list-companies`

List all companies.

- **stdout**: `{ id, slug, name, description }[]` as JSON

Since 002.04, `GET /api/company` defaults to the caller's own memberships for
the web UI's benefit; the CLI sends `?all=true` because it administers the
system, so operator behaviour is unchanged. The stat set the API now returns
alongside each company is not rendered.

```bash
./tcp-cli.sh -t $TOKEN list-companies
```

### `list-roles`

List roles grouped by company.

- **stdout**: `{ id, slug, name, description, roles: { id, slug, name, description, knowledgeDomains }[] }[]` as JSON
- **stderr**: progress/errors

| Flag                    | Alias | Description                               |
| ----------------------- | ----- | ----------------------------------------- |
| `--company-id <uuid>`   | `-c`  | Filter to a single company                |
| `--company-slug <slug>` |       | Filter to a single company, instead of ID |

```bash
./tcp-cli.sh -t $TOKEN list-roles
./tcp-cli.sh -t $TOKEN list-roles -c <companyId>
./tcp-cli.sh -t $TOKEN list-roles --company-slug acme
```

### `set-company`

Create or update a company. Reads JSON from `--input` or stdin.

- **stdout**: the created/updated company as JSON
- **stderr**: progress/errors, plus any data-quality warnings (see below)
- Update (`PUT`) when `--company-id`/`--company-slug` is given, or the input JSON contains `id`; otherwise creates (`POST`)

| Flag                    | Alias | Description                                         |
| ----------------------- | ----- | --------------------------------------------------- |
| `--company-id <uuid>`   | `-c`  | Company UUID to update (overrides `id` in the JSON) |
| `--company-slug <slug>` |       | Company slug to update instead of `--company-id`    |
| `--input <json>`        | `-i`  | JSON body (`DeepPartial<TcpCompany>`)               |

```bash
# Create
echo '{"slug":"acme","name":"Acme Corp"}' | ./tcp-cli.sh -t $TOKEN set-company

# Update (id present → PUT)
./tcp-cli.sh -t $TOKEN set-company -i '{"id":"<uuid>","name":"Acme Renamed"}'

# Update by slug, without needing to know the id
./tcp-cli.sh -t $TOKEN set-company --company-slug acme -i '{"name":"Acme Renamed"}'
```

### `set-role`

Create or update a role. Reads JSON from `--input` or stdin.

- **stdout**: the created/updated role as JSON
- **stderr**: progress/errors, plus any data-quality warnings (see below)
- Update (`PUT`) when `--role-id`/`--role-slug` is given, or the input JSON contains `id`; otherwise creates (`POST`)
- `--role-slug` requires `--company-id`/`--company-slug` (role slugs are unique only within a company)

| Flag                    | Alias | Description                                                          |
| ----------------------- | ----- | -------------------------------------------------------------------- |
| `--company-id <uuid>`   | `-c`  | Company UUID (required when creating, or updating via `--role-slug`) |
| `--company-slug <slug>` |       | Company slug, instead of `--company-id`                              |
| `--role-id <uuid>`      | `-r`  | Role UUID to update (overrides `id` in the JSON)                     |
| `--role-slug <slug>`    |       | Role slug to update instead of `--role-id`                           |
| `--input <json>`        | `-i`  | JSON body (`DeepPartial<TcpRole>`)                                   |

```bash
# Create
./tcp-cli.sh -t $TOKEN set-role -c <companyId> \
  -i '{"slug":"analyst","name":"analyst","description":"...","systemPromptTemplate":"You are {{name}}."}'

# Update by slug, without needing to know the id
./tcp-cli.sh -t $TOKEN set-role --company-slug acme --role-slug analyst \
  -i '{"description":"Updated description."}'

# Update
./tcp-cli.sh -t $TOKEN set-role -i '{"id":"<uuid>","name":"senior-analyst"}'
```

#### Data-quality warnings

`set-company` and `set-role` (and their equivalent server routes) still
succeed when data is technically valid but inadvisable — e.g. a role with no
`knowledgeDomains`, or a blank `companyContext`/`rolePrompt`. The server
reports these via the `X-Tcp-Warnings` response header (a JSON array of
strings); the CLI prints each one to **stderr in yellow, prefixed with a
warning emoji**, so piping stdout elsewhere is unaffected:

```bash
$ ./tcp-cli.sh -t $TOKEN set-role -c <companyId> -i '{"slug":"analyst","name":"analyst","description":"..."}'
⚠️  Role has no knowledgeDomains set.
⚠️  Role has a blank or missing rolePrompt.
{"id":"...","slug":"analyst", ...}
```

### `delete-company`

Delete a company. Cascades to everything owned by it — roles, agents, audit
events, conversations, knowledge-base chunks, episodic memory, and company
users — so there is nothing left to clean up separately.

Checks the company exists first; unless `--force` is given, asks for a y/n
confirmation before deleting.

- **stdout**: a one-line confirmation once deleted
- **stderr**: errors

| Flag                    | Alias | Description                              |
| ----------------------- | ----- | ---------------------------------------- |
| `--company-id <uuid>`   | `-c`  | Company UUID to delete                   |
| `--company-slug <slug>` |       | Company slug to delete instead of the ID |
| `--force`               | `-f`  | Skip the y/n confirmation prompt         |

```bash
./tcp-cli.sh -t $TOKEN delete-company --company-slug acme
./tcp-cli.sh -t $TOKEN delete-company -c <companyId> --force
```

### `delete-role`

Delete a role. Cascades to its agents, knowledge-base chunks, episodic
memory, and conversations.

Checks the role exists first; unless `--force` is given, asks for a y/n
confirmation before deleting. `--role-slug` requires `--company-id`/
`--company-slug` (role slugs are unique only within a company, not globally).

- **stdout**: a one-line confirmation once deleted
- **stderr**: errors

| Flag                    | Alias | Description                                             |
| ----------------------- | ----- | ------------------------------------------------------- |
| `--role-id <uuid>`      | `-r`  | Role UUID to delete                                     |
| `--role-slug <slug>`    |       | Role slug to delete instead of the ID (needs a company) |
| `--company-id <uuid>`   | `-c`  | Company UUID (required with `--role-slug`)              |
| `--company-slug <slug>` |       | Company slug, instead of `--company-id`                 |
| `--force`               | `-f`  | Skip the y/n confirmation prompt                        |

```bash
./tcp-cli.sh -t $TOKEN delete-role --company-slug acme --role-slug analyst
./tcp-cli.sh -t $TOKEN delete-role -r <roleId> --force
```

### `chat`

Initiate a conversation with an agent running a given role. `chat` always
means a talkable session with a role — to browse a company's roster and pick
a role interactively without committing to one up front, use
[`tui`](#tui) instead.

Conversation history is maintained server-side in the LangGraph checkpoint store.
Every agent a chat session creates (the initial one, plus any started later from
the roster) is deleted when the session ends. If the access token expires
mid-session, it is renewed automatically using the refresh token (provided via
`-T` or obtained from the initial username+password grant).

If the agent consults another role mid-chat and that consultation fails (the consulted
agent errors, times out, or never calls `complete_assignment` despite reminders), the failure
is reported back to your agent, which decides how to proceed — you get a real answer
(possibly one that explains the failure) instead of the chat hanging until the timeout.

**How a turn works.** Sending a message returns `202 Accepted` immediately; the
turn runs on the server and everything it does is streamed back live over the
agent's Server-Sent Events stream (`GET /api/agent/:id/events`). The CLI opens
that stream and renders each event until the terminal `completed` (or
`failed`) event arrives — either in the full-screen TUI (default on a TTY) or
as colour-coded scrolling text (piped output, or `--no-tui`); see below. The
SSE parser and reader (`parseWireEvents`, `readWireStream`) live in
`@tcp/shared`, not in tcp-cli itself — the same implementation is re-exported
as `@tcp/shared/client` for the web client's event streams, so the two clients
cannot drift on what an event means (ADR-025).

**Following consultations.** When your agent pauses to consult another role,
the CLI automatically opens a second stream for the consulted agent and
renders its activity too — as its own tab in the TUI, or interleaved into the
plain renderer's output. Nested consultations are followed recursively either
way.

| Flag                        | Alias | Description                                                                                                           |
| --------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------- |
| `--role-id <uuid>`          | `-r`  | Role UUID for the agent                                                                                               |
| `--role-slug <slug>`        |       | Role slug instead of `--role-id` (needs `--company-id`/`--company-slug`)                                              |
| `--company-id <uuid>`       | `-c`  | Company UUID, to scope `--role-slug`                                                                                  |
| `--company-slug <slug>`     |       | Company slug instead of `--company-id`                                                                                |
| `--query <message>`         | `-q`  | Single question, auto-submitted on startup                                                                            |
| `--hide-reasoning`          |       | Suppress the reasoning stream                                                                                         |
| `--no-tui`                  |       | Force the plain scrolling renderer, even on a TTY                                                                     |
| `--task-list-max-lines <n>` |       | Max lines a highlighted company task-list entry expands to (TUI only; default 4, env `TCP_TASK_LIST_ENTRY_MAX_LINES`) |

A role is required — `--role-id`, or `--role-slug` scoped to a company (role
slugs are unique only within a company, not globally, so `--role-slug` needs
one of the company flags alongside it; `--role-id` is self-sufficient and
can't be combined with either). A bare company with no role is rejected —
that's [`tui`](#tui)'s job.

```bash
./tcp-cli.sh -t $TOKEN chat --company-slug acme --role-slug chicken-assistant --no-tui -q 'Tell me about yourself'
```

#### Full-screen TUI (default on a TTY)

When stdout is a real terminal, `chat` (both interactive and `-q`) opens a
full-screen view instead of scrolling text — the same view [`tui`](#tui) opens
directly on the roster, with no talkable tab. This section describes the view
itself; see `chat` above and `tui` below for what each verb starts it with.

- **Pane 0 is always the company roster** — labelled with the company's name,
  opening with a `Slug: …` / `Id: …` heading and a "Please select a role to
  initiate a chat:" prompt, then a blank line, then two lists: **Roles** (the
  "initiate chat" list — role slugs aren't rendered yet, so this is just role
  names, sorted alphabetically; see `--role-slug` elsewhere in this doc for
  scripted access by slug) and **Tasks** (the company's tasks, grouped
  **Active** — `ready`/`planning`/`in-progress`/`finalising` — and
  **Completed / failed** — `succeeded`/`failed`/`cancelled` — each most
  recently updated first, live-updating from the company's SSE stream; each
  row is `<datetime> [<shortcode>] (<state>) "<request>"` — `<shortcode>` is
  the task's short per-company identifier (`000`, `001`, …, assigned at
  creation); a highlighted task expands its full prompt, word-wrapped up to
  `--task-list-max-lines` lines). **Up/Down** moves one highlight across both
  lists, cycling top↔bottom; **[** / **]** jump straight to the previous/next
  list; the view scrolls to keep the highlight visible on a long list.
  **Enter** starts a chat with a highlighted role, or opens the task panel
  (below) for a highlighted task; **r** re-fetches the role list; **n** opens
  the initiate-task form (below), regardless of which list is currently
  highlighted. It has no input box, so these keys are free for navigation
  rather than typing.
- **The task panel** (Enter on a task) is labelled `Task: <shortcode>` in the
  tab bar, and opens with `Task id:`/`Status:` (colour-coded like the
  assignment rows below)/`Prompt:` (the prompt word-wrapped, continuation
  lines indented under the opening quote), then an **Assignments** list split
  into two groups — **Incomplete** (`ready`/`in-progress`/`in-qa`) and
  **Complete** (`succeeded`/`failed`/`cancelled`) — one row per
  plan/implement/qa/finalise assignment,
  `n. <role> (<status>) [agent: <live status>] "<prompt>"`, the status
  colour-coded (grey `ready`, cyan while active, green `succeeded`, red
  `failed`, yellow `cancelled`), and word-wrapping the full prompt when
  highlighted (up to `--task-list-max-lines` lines), same as the roster's own
  task list. `n` is the assignment's position in the task's plan (`0` for the
  planning assignment, an implement step's 1-based position, or — for a qa
  row — the step it reviews) and stays fixed even once the row moves from
  Incomplete to Complete. The `[agent: …]` segment shows the assignment's
  working agent's own live status — `no agent yet` before one is dispatched,
  `waiting to start` for an `idle` agent queued behind the worker pool on an
  `in-progress` assignment (it hasn't stalled — it's waiting for a worker
  slot), or its raw status (`running`/`paused`/`completed`/`failed`/
  `cancelled`) otherwise — seeded when the panel opens and kept live from the
  company's SSE stream (agent `state_change` rows), no refetch. The rest of
  the panel updates live from the task's SSE stream. **Up/Down** moves the
  highlight, skipping assignments that haven't begun yet (nothing to open)
  and cycling across both groups; **Enter** opens the assignment panel
  (below) for a highlighted, begun assignment; **c** cancels the task
  (shown/active only while it's `planning`/`in-progress`/`finalising`); **s**
  starts it (shown/active only while it's `ready`) — the panel updates from
  the SSE stream after either, no manual refresh needed.
- **The assignment panel** (Enter on a begun assignment in a task panel) is a
  read-only scrollback of that assignment's working agent — no input box.
  Labelled `Assignment: <shortcode>` in the tab bar when the assignment has
  one (an orphan assignment — a plain chat or a consultation with no task —
  falls back to the role name, same as any other tab). It opens with
  `Agent id:` / `Role name (and slug):` / `Assignment id:` / `Assignment
shortcode:` / `Assignment status:` (colour-coded the same way) / `Prompt:`
  — the role slug and assignment fields render as `—` for a consultation
  follower (not fetched, to keep following a live consultation cheap). A
  still-running assignment streams live, the same as any other tab; a
  finished one renders its full recorded history instead (reconstructed from
  the audit log — every state change and the model's final response per turn,
  though not its token-by-token reasoning, which isn't persisted).
- **The initiate-task form** (`n` from the roster) is a fixed field list, not
  a general form: **Prompt** (required; Enter to type, Enter again to commit,
  Backspace to edit), **Planner role** (a list of the company's roles,
  pre-selecting its default planner role if it has one; Enter to choose one),
  **Expected outputs** (an add/remove list of filenames — zero is fine; Enter
  on "+ Add expected output" to type one, **d** to remove a highlighted one),
  and **Start task** (a `[ ]`/`[x]` checkbox, Enter to toggle; off by
  default). **Up/Down** moves between fields; submitting with no prompt or no
  role chosen shows an inline error instead of submitting. On success the form
  is replaced (same tab, not a new one) by the new task's task panel, started
  immediately if the checkbox was on.
- **One tab per other monitored agent** — the root agent (`chat` only; it
  opens immediately alongside the roster and becomes active), one per role
  chatted with from the roster, one per assignment opened from a task panel,
  and one per consultation any agent triggers, added live as
  `consultation_started` events arrive. Switch tabs with **Tab** /
  **Shift+Tab**; the active tab is shown in bold/bright colour. **Ctrl+W**
  closes the active tab (any tab except the roster, which is permanent) — for
  a talkable tab this also aborts its turn if one is in flight and deletes its
  agent; closing a spectator tab (a consultation follower or an assignment
  panel) just stops watching it. Closing the last agent tab leaves you back on
  the roster.
- **Independent scrollback per tab** — each agent's events accumulate in its
  own pane, opening with the assignment-panel heading described above;
  switching tabs doesn't lose or interleave another agent's output, unlike
  the plain renderer's single interleaved stream. Scroll with
  **PgUp/PgDn** (or the mouse wheel); scrolling up stops the view following
  new output, paging back to the bottom resumes it. On spectator tabs the
  arrow keys and Home/End scroll too. A blank row always separates the tab
  bar from a pane's content.
- **Input box only on talkable tabs** — the root agent's tab and any tab
  started from the roster show an input line (`> `); consultation and
  assignment-chat tabs are spectate-only, and the roster/task/initiate-task
  panels have none (see above). This includes `-q` mode: the root tab's input
  is present but disabled while the query's turn is in flight, the same as any
  busy talkable tab (see below). **Enter** sends; **Alt+Enter** inserts a line
  break (Shift+Enter can't — terminals send the same byte for Shift+Enter and
  Enter); arrow keys, Home/End, and Backspace/Delete edit as usual. Your sent
  message renders into the pane as an `input` block when its audit event
  arrives over the stream (not echoed locally), so a scrolled-back tab shows
  what was asked as well as the answer. While a turn is in flight, that tab's input still accepts typing
  but won't submit until the response arrives (its hint row says `waiting for
response…`) — other tabs are unaffected and can run turns concurrently. A
  mid-typed draft survives switching tabs, tracked independently per tab. The
  terminal's own text cursor only ever appears on an enabled input box — it's
  hidden everywhere else (the roster, spectator tabs, a busy talkable tab),
  rather than lingering wherever it last was.
- Events render as `hh:mm:ss | event_type | text`, blank-line separated;
  reasoning deltas render specially — indented two spaces, no columns, grey,
  word-wrapped — with a blank line whenever reasoning is interrupted by
  another event or resumes afterwards. A whitespace-only or empty response
  renders as `(blank)` rather than an empty line, so it's obvious the agent
  genuinely returned no content.
- **The bottom row always shows the active keybindings** for the current
  tab, in priority order — on a narrow terminal the least important hints
  (e.g. scrolling) drop first rather than truncating mid-word, so `Ctrl+C
quit` and the tab's primary action are always visible.
- **F1** (or **Ctrl+G**) opens a help tab listing every keybinding, from any
  pane — Ctrl+G is a fallback for when F1 never reaches the terminal at all
  (e.g. it's bound to brightness on Mac laptops unless Fn is held). Unlike
  other tabs it self-closes — **Tab**, **Shift+Tab**, or **Esc** away from it
  removes it outright (landing on a sensible neighbouring tab) rather than
  leaving it around like a normal tab; **Ctrl+W** closes it too.
- **Ctrl+C**: while any turn is in flight, stops watching all of them (the
  agents keep running server-side) and returns to the prompt. At the idle
  prompt, tears down the TUI, cleans up every agent created this session, and
  exits — the same two-stage behaviour as the plain renderer's Ctrl+C.
- Typing `exit` or `quit` in a talkable tab's input box ends the whole
  session, same as the plain renderer.

**`-q`/`--query` at a TTY** also opens the TUI: the message is submitted
automatically on startup, but the query is otherwise just the first message of
a normal interactive session — the response renders into the root pane like
any other turn, and the TUI **stays open afterward** rather than exiting the
moment the answer arrives, so it isn't lost if you want to ask a follow-up.
Leave the same way as any other session (Ctrl+C, or `exit`/`quit`). Piped
output (or `--no-tui`) keeps the original one-shot behaviour: print the final
answer to stdout and exit, unchanged — see the plain renderer section below.

```bash
./tcp-cli.sh -t $TOKEN chat -r <roleId>
# (full-screen TUI opens; type at the bottom input line, Tab/Shift+Tab to
# switch tabs if a consultation is in progress, Ctrl+C or 'exit' to leave)
```

#### Plain renderer (piped output, or `--no-tui`)

When stdout is piped/redirected, or `--no-tui` is passed, output stays as
colour-coded, blank-line-separated scrolling text rendered through the same
shared render library `eavesdrop` and the TUI panes use (so all three agree on
formatting) — this is also the only mode compatible with piping the final
answer to another command. Every line/block is prefixed `hh:mm:ss | <label> |`:

- **`input`** — your typed message, rendered when its `input` audit event
  arrives over the stream (the CLI no longer echoes it locally — one rendering
  path, so eavesdroppers see the same thing).
- **`state_change:agent`** — lifecycle transitions: running, paused, resumed,
  idle/completed, failed.
- **`llm_request` / `tool_call:<tool>` / `tool_result:<tool>`** — LLM/tool
  activity; tool calls/results show pretty-printed `{ tool, input|output }`
  JSON (request bodies are never dumped).
- **`llm_response:reasoning`** (grey) — the model's reasoning tokens as they
  arrive, where the provider exposes them (e.g. LM Studio). Shown by default;
  suppress with `--hide-reasoning`.
- **`llm_response:response`** — the answer content, streamed token by token; on
  stdout so it stays pipeable. A whitespace-only or empty response renders as
  `(blank)`.

**Single-query mode** (`-q` provided, piped or `--no-tui`):

- **stdout**: the agent's final response (once, so the output stays pipeable)
- **stderr**: the live streamed blocks (state, reasoning, response progress)
- Creates agent → sends message → streams the turn → prints the answer → deletes agent → exits

```bash
./tcp-cli.sh -t $TOKEN chat -r <roleId> -q "What is your role?" | tee answer.txt
```

**Interactive mode** (no `-q`, piped or `--no-tui`):

- Enters a readline prompt (`> `)
- User types messages; the streamed blocks render live, the response on stdout
- Type `exit` or `quit` to end the session
- **Ctrl+C during a turn** stops watching the stream and re-shows the prompt —
  the agent keeps running on the server. **Ctrl+C at the idle prompt** cleans up
  the agent and exits.
- The agent is always cleaned up on a clean exit.

```bash
./tcp-cli.sh -t $TOKEN chat -r <roleId> --no-tui
# > Tell me about Q3 trends.
#
# 14:03:20 | input | Tell me about Q3 trends.
#
# 14:03:20 | state_change:agent | running
#
# 14:03:21 | llm_response:reasoning |
#
#   the user wants a summary of…
#
# 14:03:22 | llm_response:response |
#
#   Q3 revenue rose 12% driven by…
#
# Agent state: completed
# > exit
# Agent <id> removed.
```

### `tui`

Opens the full-screen TUI ([described above](#full-screen-tui-default-on-a-tty))
straight onto a company's roster — no role required, and no agent started.
Pick a role there (Up/Down, Enter) to start chatting, open a task (Enter) to
see its assignments, or press **n** to initiate a new one. The dedicated way
to browse a company without committing to a role up front; [`chat`](#chat)
always requires one.

| Flag                        | Alias | Description                                                                                                                            |
| --------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `--company-id <uuid>`       | `-c`  | Company UUID                                                                                                                           |
| `--company-slug <slug>`     |       | Company slug instead of `--company-id`                                                                                                 |
| `--hide-reasoning`          |       | Suppress the reasoning stream                                                                                                          |
| `--task-list-max-lines <n>` |       | Max lines a highlighted company task-list entry (or task-panel assignment) expands to (default 4, env `TCP_TASK_LIST_ENTRY_MAX_LINES`) |

Requires a TTY — there is no piped/plain-renderer fallback, since the whole
point of this verb is the interactive roster.

```bash
./tcp-cli.sh -t $TOKEN tui --company-slug acme
# (opens straight onto the company's roster — no agent yet; Up/Down to pick a
# role or a task, Enter to open it, 'n' to initiate a new task)
```

### `list-knowledge`

List the knowledge-base documents currently stored for a role, or for a company's shared knowledge.

- **stdout**: JSON array of `{ key, name, size, lastModified }` — empty array if none stored

| Flag                     | Alias | Description                                   |
| ------------------------ | ----- | --------------------------------------------- |
| `--role <slug-or-id>`    | `-r`  | Role slug or UUID                             |
| `--company <slug-or-id>` | `-c`  | Company slug or UUID (shared knowledge scope) |

```bash
./tcp-cli.sh -t $TOKEN list-knowledge -r <roleId>
./tcp-cli.sh -t $TOKEN list-knowledge --company acme --role analyst
./tcp-cli.sh -t $TOKEN list-knowledge -c acme
```

### `get-knowledge`

Retrieve a single knowledge-base document's content, for a role or a company's shared knowledge.

- **stdout**: the document's raw content (unless `--out` is given)

| Flag                     | Alias | Description                                        |
| ------------------------ | ----- | -------------------------------------------------- |
| `--role <slug-or-id>`    | `-r`  | Role slug or UUID                                  |
| `--company <slug-or-id>` | `-c`  | Company slug or UUID (shared knowledge scope)      |
| `--file <filename>`      | `-f`  | **(Required)** Filename to retrieve                |
| `--out <path>`           | `-o`  | Save to a local file instead of printing to stdout |

```bash
./tcp-cli.sh -t $TOKEN get-knowledge -r <roleId> -f policy.md
./tcp-cli.sh -t $TOKEN get-knowledge -c acme -f handbook.md -o ./handbook.md
```

### `store-knowledge`

Upload (or overwrite) a single document into a role's knowledge base, or a company's shared knowledge. The file's extension is checked before upload — if it's not supported, nothing is sent.

Accepts `.md`, `.txt`, `.html`, `.pdf`, `.docx`, `.csv`, `.json`, and `.yaml`. The server converts non-`.md` formats to OKF Markdown (YAML front-matter with a `title` field, generated from the source's own title/heading, or the filename if neither is present) and stores the result under a `.md` filename — e.g. `report.pdf` is stored as `report.md`. A derived name that collides with an existing document is rejected (409) rather than silently overwritten, unless `--target` is given explicitly. `.md` files are passed through unchanged and must already carry valid OKF front-matter with a non-empty `title` field — this is not auto-generated.

- **stdout**: JSON `{ key, name, size, lastModified }` for the stored document
- **stderr**: validation errors and upload progress

| Flag                     | Alias | Description                                                                                     |
| ------------------------ | ----- | ----------------------------------------------------------------------------------------------- |
| `--role <slug-or-id>`    | `-r`  | Role slug or UUID                                                                               |
| `--company <slug-or-id>` | `-c`  | Company slug or UUID (shared knowledge scope)                                                   |
| `--source <path>`        | `-s`  | **(Required)** Local file path to upload                                                        |
| `--target <filename>`    | `-t`  | Filename to store as (defaults to the source basename, `.md`-extensioned for converted formats) |

```bash
./tcp-cli.sh -t $TOKEN store-knowledge -r <roleId> -s policy.md
./tcp-cli.sh -t $TOKEN store-knowledge --company acme --role analyst -s policy.md
./tcp-cli.sh -t $TOKEN store-knowledge -c acme -s ./handbook.md -t company-handbook.md
./tcp-cli.sh -t $TOKEN store-knowledge -c acme -s ./report.pdf
```

Documents are stored in MinIO under `{company_slug}/knowledge/{role_slug}/` (or `{company_slug}/knowledge/shared/` for company scope) and automatically indexed for RAG retrieval. See [shared-storage.md](shared-storage.md) for the storage layout.

### `delete-knowledge`

Delete a single knowledge-base document by filename, from a role's knowledge base or a company's shared knowledge. Removes it from MinIO and its RAG chunks from the database. Idempotent — deleting an unknown filename is not an error.

- **stdout**: JSON `{ deleted: filename }`

| Flag                     | Alias | Description                                   |
| ------------------------ | ----- | --------------------------------------------- |
| `--role <slug-or-id>`    | `-r`  | Role slug or UUID                             |
| `--company <slug-or-id>` | `-c`  | Company slug or UUID (shared knowledge scope) |
| `--file <filename>`      | `-f`  | **(Required)** Filename to delete             |

```bash
./tcp-cli.sh -t $TOKEN delete-knowledge -r <roleId> -f policy.md
./tcp-cli.sh -t $TOKEN delete-knowledge -c acme -f handbook.md
```

### `reindex-knowledge`

Force a full RAG rebuild of every knowledge scope of a company (shared plus every role). Embeddings normally stay in sync automatically — via a write hook on every knowledge write and a background reconciliation poller (see [shared-storage.md → Automatic RAG sync](shared-storage.md#automatic-rag-sync-01022)). Use this to rebuild immediately after editing files directly in the MinIO console, rather than waiting for the poller. The server responds `202 Accepted` and rebuilds asynchronously.

- **stdout**: JSON `{ reindexing: true }`

| Flag                     | Alias | Description                         |
| ------------------------ | ----- | ----------------------------------- |
| `--company <slug-or-id>` | `-c`  | **(Required)** Company slug or UUID |

```bash
./tcp-cli.sh -t $TOKEN reindex-knowledge -c acme
```

### `get-knowledge-index-status`

Report the RAG-indexing status of a role's knowledge scope, or of a company's shared scope plus every role. For a role, stdout is a single status object; for a company, it's the shared scope's status plus one entry per role. `documentCount`/`totalBytes` come from the live storage listing, `chunkCount` from the `knowledge_chunk` table, and `generation`/`lastIndexedAt`/`indexing` from the reindex state (see [shared-storage.md → Automatic RAG sync](shared-storage.md#automatic-rag-sync-01022)) — `lastIndexedAt` is `null` until the scope's first successful rebuild completes.

- **stdout** (role scope): JSON `{ documentCount, totalBytes, chunkCount, generation, lastIndexedAt, indexing }`
- **stdout** (company scope): JSON `{ shared: <status>, roles: [{ roleId, roleSlug, status }] }`

| Flag                     | Alias | Description                                                |
| ------------------------ | ----- | ---------------------------------------------------------- |
| `--role <slug-or-id>`    | `-r`  | Role slug or UUID                                          |
| `--company <slug-or-id>` | `-c`  | Company slug or UUID (shared knowledge scope + every role) |

```bash
./tcp-cli.sh -t $TOKEN get-knowledge-index-status -r <roleId>
./tcp-cli.sh -t $TOKEN get-knowledge-index-status -c acme
```

### `query-knowledge`

Runs a RAG similarity search for a role and prints the raw chunks that would be injected into a prompt — the same data RAG injection would provide, without invoking any chat/LLM call. Searches the role's own chunks plus its company's shared chunks in one call, so there's no separate company-only variant.

- **stdout**: JSON `{ id, documentPath, chunkIndex, content, similarity }[]`, ranked by similarity descending

| Flag                  | Alias | Description                                                                                                                                                                                           |
| --------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--role <slug-or-id>` | `-r`  | **(Required)** Role slug or UUID                                                                                                                                                                      |
| `--query <text>`      | `-q`  | **(Required)** Query text                                                                                                                                                                             |
| `--top-k <n>`         |       | Maximum chunks to return (default 5, matching the server)                                                                                                                                             |
| `--threshold <n>`     |       | Minimum cosine similarity to include. Defaults to the value the role itself would use (`runConfig.ragThreshold` → `RAG_THRESHOLD` → built-in), so the output matches what a real prompt would receive |

```bash
./tcp-cli.sh -t $TOKEN query-knowledge -r <roleId> -q "remote work policy"
./tcp-cli.sh -t $TOKEN query-knowledge -r <roleId> -q "remote work policy" --top-k 3 --threshold 0.5
# Calibration: --threshold 0 shows every chunk with its raw score, including
# ones the role's own threshold would filter out.
./tcp-cli.sh -t $TOKEN query-knowledge -r <roleId> -q "remote work policy" --threshold 0
```

Queries are embedded and matched by meaning, not keywords: a natural-language
question ("how do I mount a shelf on a plasterboard wall?") scores measurably
better than a bare keyword ("shelves"). If a search returns nothing, see
[Tuning RAG retrieval](development.md#tuning-rag-retrieval) — a threshold above
the embedding model's score range filters out everything, silently.

### `open-document-store`

Print the MinIO console URL and open it in the default browser. Useful for browsing stored files during development.

- **stdout**: the console URL
- The URL is read from the `MINIO_CONSOLE_URL` environment variable (default: `http://localhost:9001`)

| Flag        | Description                      |
| ----------- | -------------------------------- |
| `--no-open` | Print the URL without opening it |

```bash
# Open in browser
./tcp-cli.sh open-document-store

# Print URL only
./tcp-cli.sh open-document-store --no-open
```

No authentication required — the MinIO console has its own login (see [shared-storage.md → Authentication](shared-storage.md#authentication)).

---

### `open-swagger`

Print the Swagger UI URL for one of the six server apps and open it in the default browser.

- **stdout**: the Swagger UI URL (`{base}/swagger`)
- Base URLs come from `TCP_<SERVICE>_BROWSER_URL` env vars (Docker-internal `TCP_*_URL` values aren't reachable from the host browser), defaulting to `http://localhost:<port>`

| Flag               | Description                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `--service <name>` | **(Required)** `tcp-server \| tcp-agent \| tcp-mcp-storage \| tcp-mcp-memory \| tcp-mcp-interactions \| tcp-mcp-tasks` |
| `--no-open`        | Print the URL without opening it                                                                                       |

```bash
./tcp-cli.sh open-swagger --service tcp-server

# Print URL only
./tcp-cli.sh open-swagger --service tcp-mcp-tasks --no-open
```

No authentication required to print/open the URL — the Swagger UI itself has no separate login.

---

### `list-open-queries`

List open agent-to-human queries (conversations with `status: awaiting_user`) that are waiting for a response.

- **stdout**: formatted table (default), JSON, or CSV depending on `--format`
- **stderr**: progress messages

| Flag                    | Description                         |
| ----------------------- | ----------------------------------- |
| `-c, --company-id <id>` | Filter to a specific company        |
| `--company-slug <slug>` | Filter to a company, instead of ID  |
| `--format <fmt>`        | `table` (default), `json`, or `csv` |

```bash
# Default table output
./tcp-cli.sh list-open-queries

# Filter to a company, JSON output
./tcp-cli.sh list-open-queries -c <companyId> --format json

# Filter to a company by slug
./tcp-cli.sh list-open-queries --company-slug acme
```

The table columns are: slug, role name, and the first 120 characters of the question.

---

### `read-query`

Read the full question, context, and reply history for a single query by its slug.

- **stdout**: full conversation content
- **stderr**: progress messages
- Timestamps are stored as UTC and displayed localized to the owning company's
  `timezone` (an IANA name, e.g. `Europe/London`), when set — otherwise shown
  in the system locale's default timezone

```bash
./tcp-cli.sh read-query analyst-3
```

---

### `respond`

Reply to an open query. Once submitted, the waiting agent is automatically re-enqueued and will resume with your reply injected as a `HumanMessage`. (If the agent raised several requests before pausing — e.g. a consultation and a user query — it resumes only once all of them are resolved, and sees every response at once.)

- **stdout**: `{ slug, status }` JSON
- **stderr**: progress messages (`"Sending response..."`, `"Agent resumed."`)

```bash
./tcp-cli.sh respond analyst-3 "The budget is $50,000 for Q3."
```

The message argument is a plain string. Quotes are handled by your shell in the usual way.

---

### `download-shared-document`

Download a file from shared company storage to the local filesystem.

- **stdout**: `{ source, target, size }` JSON on success
- **stderr**: progress messages

| Flag              | Description                                                             |
| ----------------- | ----------------------------------------------------------------------- |
| `--source <path>` | Required. Object key in MinIO (e.g. `acme/tasks/xyz/output/out.md`)     |
| `--target <path>` | Local destination path. Defaults to `./<filename>` (basename of source) |

```bash
# Download to current directory
./tcp-cli.sh download-shared-document --source acme/tasks/xyz/output/report.md

# Download to a specific path
./tcp-cli.sh download-shared-document --source acme/tasks/xyz/output/report.md --target ~/Desktop/report.md
```

---

### `upload-shared-document`

Upload a local file to shared company storage.

- **stdout**: `{ key, size }` JSON on success
- **stderr**: progress messages

| Flag              | Description                                                                        |
| ----------------- | ---------------------------------------------------------------------------------- |
| `--source <path>` | Required. Local file path to upload                                                |
| `--target <path>` | Required. Object key destination in MinIO (e.g. `acme/knowledge/analyst/guide.md`) |

```bash
./tcp-cli.sh upload-shared-document --source ./architecture.md --target acme/knowledge/architect/architecture.md
```

MIME type is inferred from the file extension. Supported formats include `.md`, `.txt`, `.json`, `.pdf`, `.png`, `.jpg`, and `.jpeg`.

---

### `create-task`

Creates a task in the `ready` state, optionally uploads material files, and
optionally starts it. See [tasks.md](tasks.md) for the task/assignment data
model.

- **stdout**: the created (or started) task as JSON
- **stderr**: upload/start progress messages

| Flag                          | Alias | Description                                                       |
| ----------------------------- | ----- | ----------------------------------------------------------------- |
| `--company <slug-or-id>`      | `-c`  | Required. Company slug or UUID                                    |
| `--request <text>`            | `-r`  | Required. The user's statement of the work                        |
| `--planner-role <slug-or-id>` |       | Explicit planner role; falls back to the company default at start |
| `--materials <paths...>`      | `-m`  | Local material file paths to upload                               |
| `--expected <filename>`       | `-e`  | Repeatable. Filename expected in the task's completed directory   |
| `--start`                     |       | Start the task immediately after creation (and materials upload)  |

> [!NOTE]
> **Behaviour change:** `--expected` used to be a Commander _variadic_ option
> (`--expected a.txt b.txt` in one occurrence). It is now _repeatable_ instead
> — repeat the flag once per filename (`-e a.txt -e b.txt`). `./tcp-cli.sh`'s
> own `-e`/`--env` wrapper flag only intercepts `-e` up to the first
> non-wrapper argument (the verb) — `create-task -e report.md` is unambiguous
> since `-e` follows the verb.

```bash
./tcp-cli.sh -t $TOKEN create-task -c acme -r "Write a market analysis report" -e report.md

./tcp-cli.sh -t $TOKEN create-task -c acme -r "Write a market analysis report" \
  -e report.md -e summary.md

./tcp-cli.sh -t $TOKEN create-task -c acme -r "Summarise the attached brief" \
  -m ./brief.pdf --planner-role planner --start
```

### `list-tasks`

Lists a company's tasks.

- **stdout**: `TcpTask[]` as JSON

```bash
./tcp-cli.sh -t $TOKEN list-tasks -c acme
```

### `get-task`

Retrieves a task with its assignments (ordered: implement-mode plan
assignments by `orderIndex`, then the rest by creation time), including QA
outcomes, and why it is waiting, if it is.

- **stdout**: the task as JSON, with its fields at the top level plus
  `assignments` and `waiting`. `waiting` is `null`, or
  `{ kind, pausedBy?, resumeAfter? }`: `kind` is `manual` (a user paused it,
  `pausedBy` says who), `rate_limited` (`resumeAfter` is the next try),
  `spend_cap`, `shutdown`, `restart`, `user_input`, `consultation` or `queued` (waiting
  for a model slot). A failed task's `failureReason` says what went wrong and
  what to do.

```bash
./tcp-cli.sh -t $TOKEN get-task --task-id <uuid>
```

### `set-task`

Edits an unstarted task (`request`/`plannerRoleId`/`materials`/`expected`).
Reads JSON from `--input` or stdin — a deep-partial, like `set-company`/
`set-role`, applied via `PUT /api/task/:id`. `id`, `companyId`, `status`,
`completed`, and `failureReason` are not editable.

- **stdout**: the updated task as JSON
- Returns `409` once the task has left `ready` (already started) — only
  unstarted tasks can be edited
- Returns `400`/`404` if `plannerRoleId` is given but doesn't resolve to a
  role belonging to the task's company

| Flag               | Alias | Description                        |
| ------------------ | ----- | ---------------------------------- |
| `--task-id <uuid>` |       | Required. Task UUID                |
| `--input <json>`   | `-i`  | JSON body (`DeepPartial<TcpTask>`) |

```bash
./tcp-cli.sh -t $TOKEN set-task --task-id <uuid> -i '{"request":"Write a longer report"}'
echo '{"expected":[{"type":"inline-text","value":"a summary"}]}' | ./tcp-cli.sh -t $TOKEN set-task --task-id <uuid>
```

### `set-planner`

Sets a company's or an unstarted task's planner role. Exactly one of a
company target (`--company`/`--company-id`/`--company-slug`) or `--task-id`
must be given; `--role`/`--role-id`/`--role-slug` is always required.

- A company target updates `TcpCompany.plannerRoleId` (`PUT /api/company/:id`)
  — the fallback used by any task in that company with no planner of its own.
- A task target updates `TcpTask.plannerRoleId` (`PUT /api/task/:id`),
  inheriting that endpoint's "unstarted only" guard (`409` once started). A
  `--role-slug` is scoped to the task's own company (resolved via `GET
/api/task/:id` first), even though only a task was named.
- **stdout**: the updated company or task as JSON

```bash
./tcp-cli.sh -t $TOKEN set-planner --company-slug acme --role-slug planner
./tcp-cli.sh -t $TOKEN set-planner --task-id <uuid> --role-slug planner
```

### `start-task`

Starts a task that hasn't been started yet — the standalone equivalent of
`create-task --start`, for a task already created (and possibly edited via
`set-task`/`set-planner`) earlier.

- **stdout**: the started task as JSON
- Returns `422` if neither the task nor its company has a resolvable planner
  role (set one first via `set-planner`)
- Returns `409` on a double start

```bash
./tcp-cli.sh -t $TOKEN start-task --task-id <uuid>
```

### `pause-task`

Pauses a running task (`planning`, `in-progress` or `finalising`). Its agents
stop after their current step: no LLM call is cut off. Nothing restarts them —
not a reply, a consultation result or a sweep — until `resume-task`. Replies
that arrive meanwhile are kept and given to the agents on resume.

- **stdout**: the paused task as JSON (`pausedAt`, `pausedBy` set)
- Returns `409` if the task isn't running, or is already paused

```bash
./tcp-cli.sh -t $TOKEN pause-task --task-id <uuid>
```

### `resume-task`

Resumes a paused task: lifts a `pause-task`, and resumes its agents paused by
it, a spend cap, a shutdown or a rate limit, plus any whose awaited reply has
arrived. Exempts the task from spend caps only if a cap is reached at that
moment — the same rule as `start-task`.

- **stdout**: `{ resumed }` as JSON (the number of agents a resume was requested for)
- Returns `503` while the system is shutting down

| Flag               | Description         |
| ------------------ | ------------------- |
| `--task-id <uuid>` | Required. Task UUID |

```bash
./tcp-cli.sh -t $TOKEN resume-task --task-id <uuid>
```

### `cancel-task`

Cancels a task: transitions any non-terminal status (`ready`, `planning`,
`in-progress`, `finalising`) to `cancelled`, and cascades the cancellation to
its still-non-terminal assignments and their working agents. A running
agent's loop notices the cancellation on its next status check (typically
within one iteration) and stops without writing further output.

- **stdout**: the cancelled task as JSON
- Returns `409` if the task is already terminal (`succeeded`, `failed`, or
  already `cancelled`) — cancelling twice is safe (idempotent), the second
  call just fails with 409 rather than repeating the cascade

```bash
./tcp-cli.sh -t $TOKEN cancel-task --task-id <uuid>
```

### `list-agents`

Lists agents for a role or a company, defaulting to currently active agents
(`idle`, `running`, `paused`) unless `--filter status=` overrides it.

- **stdout**: `TcpAgent[]` as JSON

| Flag                               | Description                                                |
| ---------------------------------- | ---------------------------------------------------------- |
| `--role`/`--role-id`/`--role-slug` | Role to filter to (any variant)                            |
| `--company`/`-id`/`-slug`          | Company to filter to (any variant)                         |
| `--filter status=<status>`         | Repeatable. Overrides the default active-status filter     |
| `--filter role=<slug-or-id>`       | Repeatable. Overrides the top-level role scope             |
| `--filter assignment=<id>`         | Repeatable. Filter to agents working a specific assignment |

```bash
./tcp-cli.sh -t $TOKEN list-agents --company acme
./tcp-cli.sh -t $TOKEN list-agents --role analyst --company acme --filter status=paused
```

### `list-assignments`

Lists assignments for a task or a company.

- **stdout**: `TcpAssignment[]` as JSON

| Flag                         | Description                                                               |
| ---------------------------- | ------------------------------------------------------------------------- |
| `--task-id <uuid>`           | Task to list assignments for                                              |
| `--company`/`-id`/`-slug`    | Company to list assignments for (any variant)                             |
| `--filter status=<status>`   | Repeatable                                                                |
| `--filter task=<task-id>`    | Repeatable. Overrides `--task-id`                                         |
| `--filter task=null`         | Repeatable. Lists orphan assignments (plain conversations, consultations) |
| `--filter role=<slug-or-id>` | Repeatable                                                                |

```bash
./tcp-cli.sh -t $TOKEN list-assignments --task-id <uuid>
./tcp-cli.sh -t $TOKEN list-assignments --company acme --filter task=null
```

### `eavesdrop`

Reconstructs the history of, and/or follows live, an agent, assignment, or
task — for understanding what a company is currently doing beyond what
`get-task` shows, including orphaned (non-task) assignments.

Exactly one target flag is required. `--show-history` and `--tail` may be
combined (history prints first, then the tail follows).

| Flag                     | Description                                                                       |
| ------------------------ | --------------------------------------------------------------------------------- |
| `--agent-id <uuid>`      | Eavesdrop on a single agent                                                       |
| `--assignment-id <uuid>` | Eavesdrop on an assignment (its working agent, if any)                            |
| `--task-id <uuid>`       | Eavesdrop on a task (every plan/implement/qa/finalise assignment's working agent) |
| `--show-history`         | Reconstruct past events from the audit log and print them to stdout               |
| `--tail`                 | Follow current events live, via the same SSE stream `chat` uses                   |

- **stdout**: history (`--show-history`) and the live tail (`--tail`) render
  through **one shared pipeline** (the `apps/backend/apps/tcp-cli/src/lib/render/` library,
  the same one `chat` and the `tui` panes use), so replayed history is
  line-for-line identical to eavesdropping the same activity live. A scope
  heading block is printed whenever the active `(task, assignment, agent)`
  scope changes (a `--task-id` view spans several):

  ```text
  Task id:              <id>
  Task shortcode:       <shortcode>
  Assignment id:        <id>
  Assignment role:      <role name> (<role slug>)
  Assignment role id:   <id>
  Assignment mode:      <mode>
  Assignment shortcode: <shortcode>
  Agent id:             <id>
  ```

  (unknown fields render `—`; the task lines are omitted for a plain chat
  scope). Each audit event then renders as either a **line** —
  `hh:mm:ss | <eventType>[:<kind>] | <text>` (e.g. `state_change:agent`,
  `compaction:started`, `decision`, bare `llm_request` — request bodies are
  **never** dumped) — or a **content block**: the `hh:mm:ss | <label> |`
  header, a blank line, then the content indented two spaces —
  `tool_call:<tool>` / `tool_result:<tool>` as pretty-printed `{ tool, input|
output }` JSON, and `llm_response` replayed as a reasoning block then a
  response block. `agent_loop_completion` keeps its fixed `assignment complete`
  label. Colour is applied only when stdout is a TTY.

- `--tail` warns and exits non-zero if the target has already finished (or,
  for `--assignment-id`, hasn't started yet — nothing to follow)
- `--tail --task-id` follows every assignment present when it starts, and
  keeps watching the task's own SSE stream afterward so an assignment that
  starts later (the next plan step, its QA review, the finalise pass, or a
  consultation once it inherits the parent's `taskId`) is picked up too,
  rather than only ever tailing what existed at start time
- `--task-id` history/tail covers the task's own assignments only; a
  consultation spawned mid-assignment that predates `parentAssignmentId`
  inheritance is a separate orphan assignment with no link back to the task,
  so it isn't traced (eavesdrop directly on that consultation's
  `--assignment-id`/`--agent-id` instead, once you have its id from
  `list-assignments --filter task=null`)

```bash
# Replay everything that happened on a task so far
./tcp-cli.sh -t $TOKEN eavesdrop --task-id <uuid> --show-history

# Watch a still-running assignment live
./tcp-cli.sh -t $TOKEN eavesdrop --assignment-id <uuid> --tail

# Both: catch up, then keep watching
./tcp-cli.sh -t $TOKEN eavesdrop --agent-id <uuid> --show-history --tail
```

> **2026-07-18 — implementation note (010.5.1):** history and tail now feed
> the **same** `EventLogBuffer`/`StreamPresenter` from the shared render
> library — audit rows (`--show-history`) and live `WireEvent`s (`--tail`) are
> one pipeline, so the two can't drift. This replaced the earlier split where
> `--show-history` had its own row-shaped renderer and `--tail` reused `chat`'s
> renderer. Audit events are now the single source of truth for both (see
> [ADR-008](ADRs/ADR-008-audit-logging.md)).

### `estimate-context-window`

Estimates the worst-case token footprint of a role's initial prompt (system
prompt + role prompt + company context + services message + task query + RAG
retrieval) plus a projected run of further conversation turns, and reports it
against the resolved LLM's context window (`role.llmConfig` → `company.llmConfig`
→ the built-in default). Reuses the same tiktoken-based `ContextBudgetService`
the server uses to decide when to compact context mid-run — no separate
counting logic.

Company/role are optional: with neither given, the estimate uses only the
baked-in default system prompt template and the registered MCP services.

- **stdout**: the total token count (default), or the full breakdown as JSON (`--json`)
- **stderr**: the window size, turn count, and RAG estimate actually used

| Flag                    | Alias | Description                                                                                       |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------- |
| `--company-id <uuid>`   | `-c`  | Company to estimate for                                                                           |
| `--company-slug <slug>` |       | Company slug, instead of `--company-id`                                                           |
| `--role-id <uuid>`      | `-r`  | Role to estimate for                                                                              |
| `--role-slug <slug>`    |       | Role slug, instead of `--role-id` (requires a company identifier)                                 |
| `--from-file <path>`    |       | Read `{"company":...,"role":...}` from a JSON file instead of a live server                       |
| `--query <text>`        |       | Actual task query text to size (counted exactly)                                                  |
| `--query-tokens <n>`    |       | Estimated query size in tokens, when `--query` isn't given (default: 200)                         |
| `--rag-tokens <n>`      |       | Estimated RAG retrieval size in tokens (default: worst case, 5 chunks × 2000 chars ≈ 2500 tokens) |
| `--turn-tokens <n>`     |       | Estimated tokens per further conversation turn (default: 300)                                     |
| `--turns <n>`           | `-n`  | Number of further turns to project (default: 20)                                                  |
| `--json`                |       | Print the full breakdown instead of just the total                                                |

```bash
# Quick total for a specific role
./tcp-cli.sh estimate-context-window --company-slug acme --role-slug analyst

# Full breakdown, without hitting a live server
./tcp-cli.sh estimate-context-window --from-file ./role-fixture.json --json
```

### `validate-shared-document`

Re-validates document(s) already in shared storage against the same rules
enforced when tcp-server writes a document (JSON/YAML/OKF Markdown/plain
Markdown/XML/CSV — see [shared-storage.md](shared-storage.md#write-validation)).
Exists because a user could write directly to the backing object store,
bypassing tcp-server's write-time validation gate entirely — this gives an
independent way to check what's actually there.

`--path` accepts a specific object key or a glob (`*`, `?`), matched against
full keys. `--recursive` includes nested entries under a directory/glob
prefix; by default only immediate children are checked.

- **stdout**: JSON `{ query: { path, recursive }, validations: [{ path, found, size, valid, errors }] }`
- **Exit codes**: `0` on a completed check (even when some `validations[].valid` are `false` — that's a successful check that found problems, not a failed request), `1` if the server returns a non-2xx response — a 404 when `--path` names a specific file or directory that doesn't exist (a glob matching zero files is still a `0`/success), or a 500 for an unexpected server error.

| Flag            | Description                                                                    |
| --------------- | ------------------------------------------------------------------------------ |
| `--path <path>` | Object key or glob pattern (`*`, `?`) to validate (required)                   |
| `--recursive`   | Include nested entries under a directory/glob prefix (default: immediate only) |

```bash
# Validate a single document
./tcp-cli.sh validate-shared-document --path acme/knowledge/analyst/report.md

# Validate every document under a role's knowledge base, including subfolders
./tcp-cli.sh validate-shared-document --path "acme/knowledge/analyst/*" --recursive
```

### `shutdown`

Drains the simulation for shutdown, then halts it.

Draining means: refuse new work, and bring every running agent to rest. A
**graceful** shutdown (the default) lets each agent finish the LLM call it is
already making and stop at its next resumable point, so nothing already paid
for is thrown away — which is why it can legitimately take minutes. Progress is
reported on stderr while it waits.

`--force` aborts the in-flight LLM calls instead of waiting. **This wastes the
tokens already spent on them.** Use it when you need the stack down now and
accept the cost.

Either way the agents end up `paused` with the reason `shutdown`, keeping their
LangGraph checkpoints. They stay paused across a restart and are resumed
explicitly, with [`resume-task`](#resume-task) or
[`resume-company`](#resume-company). Nothing auto-resumes a shutdown pause on
boot, so bringing the stack up never starts spending tokens by itself. To have
work carry on by itself, use [`restart`](#restart) instead.

Halting the containers is done by `tcp-cli.sh` (via `docker compose stop`)
after the API reports the system drained, not by the server: every Compose
service is `restart: unless-stopped`, so a service that stopped itself would be
restarted seconds later. See [ADR-019](ADRs/ADR-019-graceful-shutdown.md). When
no `tcp-dev` containers are running — a bare `npm run start:dev`, say — it says
so and leaves the processes for you to stop.

- **stdout**: the final shutdown status as JSON
  (`{ state, forced, agentsRunning, restart, restartSupported }`)
- **stderr**: one progress line per poll
- **Exit codes**: `0` once drained; `1` on timeout, having reported what is
  still running. A timeout never escalates to `--force` — throwing away
  part-paid-for work is your decision, not a fallback

| Flag               | Description                                                              |
| ------------------ | ------------------------------------------------------------------------ |
| `-f, --force`      | Abort in-flight LLM calls immediately, wasting the tokens spent on them  |
| `--no-stop`        | Drain only; leave the containers running                                 |
| `--timeout <secs>` | Give up waiting after this many seconds and exit non-zero (default: 600) |

```bash
# Graceful: drain, wait for every agent to pause, then stop the containers
./tcp-cli.sh -t $TOKEN shutdown

# Forced: abort in-flight LLM work, then stop the containers
./tcp-cli.sh -t $TOKEN shutdown --force

# Drain only — useful before a deploy that will restart the containers anyway
./tcp-cli.sh -t $TOKEN shutdown --no-stop

# Give up after two minutes and report what is still running
./tcp-cli.sh -t $TOKEN shutdown --timeout 120
```

To cancel a drain that is taking too long, without halting anything, use
[`cancel-shutdown`](#cancel-shutdown).

### `restart`

Drains the system like [`shutdown`](#shutdown), then restarts tcp-server and
tcp-agent instead of halting them. Running agents are paused with the reason
`restart`, and the next boot resumes them by itself, from their checkpoints.
A task a user paused stays paused.

Once the drain has quiesced, both services exit and Docker's
`restart: unless-stopped` starts them again. A restart is refused (409) where
nothing would start them again (`TCP_RESTART_SUPPORTED` unset, as in a bare
`npm run start:dev`), or while a plain shutdown is already draining. See
[ADR-034](ADRs/ADR-034-restart-and-startup-recovery.md).

- **stdout**: the final status as JSON, once the server answers `idle` again
- **stderr**: one progress line per poll while draining, then
  `Restarting the services…`
- **Exit codes**: `0` once the services are back; `1` on timeout

| Flag               | Description                                                                       |
| ------------------ | --------------------------------------------------------------------------------- |
| `-f, --force`      | Abort in-flight LLM calls immediately, wasting the tokens spent on them           |
| `--timeout <secs>` | Give up waiting for the drain and the restart together, and exit 1 (default: 600) |

```bash
./tcp-cli.sh -t $TOKEN restart
```

### `cancel-shutdown`

Cancels a shutdown or restart in progress, so the system takes work again
(`DELETE /api/system/shutdown`). Agents the drain already paused stay paused:
resume them with [`resume-task`](#resume-task) or
[`resume-company`](#resume-company). Administrator-only.

- **stdout**: the resulting status as JSON

```bash
./tcp-cli.sh -t $TOKEN cancel-shutdown
```

### `get-health`

Prints the health of every service as JSON, from `GET /api/system/health`.
tcp-server asks tcp-agent and the MCP servers on the internal network, so this
works even though they aren't published to the host. Each service is `up`,
`down` or `not_configured`, with its own health document as `detail` and, when
the probe itself failed, an `error`. Administrator-only.

- **stdout**: `{ status: 'ok' | 'degraded', services: [...] }`, or with `--app`
  only that service's entry
- **Exit codes**: `0` even when degraded (the command reports health; it
  doesn't judge it); `1` for an unknown `--app`, listing the known names

| Flag           | Description                                     |
| -------------- | ----------------------------------------------- |
| `--app <name>` | Show only this service, for example `tcp-agent` |

```bash
./tcp-cli.sh -t $TOKEN get-health
./tcp-cli.sh -t $TOKEN get-health --app tcp-mcp-tasks
```

---

## Spend tracking and notifications

Reports per-provider spend caps and usage (configured via `SPEND_CAPS`), and
the application-wide notifications that threshold/cap/reset events raise.
`resume-task`/`resume-company` undo a cap-driven pause explicitly;
`dismiss-cap`/`restore-cap` change the cap itself and are administrator-only.

### `usage`

Reports application-wide spend caps, progress and totals. With
`--company-id`, also fetches that company's own usage and merges it under
`company`.

- **stdout**: `SpendOverview` as JSON; with `--company-id`,
  `{ ...SpendOverview, company: CompanySpend }`

| Flag                        | Description                          |
| --------------------------- | ------------------------------------ |
| `--company-id <id-or-slug>` | Also report this company's own usage |

```bash
./tcp-cli.sh -t $TOKEN usage
./tcp-cli.sh -t $TOKEN usage --company-id acme
```

### `notifications`

Lists application-wide notifications (spend thresholds, caps reached, resets,
untracked providers), newest first. With `--company-id`, also lists that
company's own notices: a task that failed, or one a shutdown paused. Only the
company's members may list them (`403` otherwise).

- **stdout**: `TcpNotification[]` as JSON

| Flag                  | Description                                 |
| --------------------- | ------------------------------------------- |
| `--all`               | Include already-dismissed notifications     |
| `--company-id <uuid>` | Also list this company's own (task) notices |

```bash
./tcp-cli.sh -t $TOKEN notifications
./tcp-cli.sh -t $TOKEN notifications --all
./tcp-cli.sh -t $TOKEN notifications --company-id <uuid>
```

### `dismiss-notification`

Dismisses a notification for every user. Idempotent.

- **stdout**: the dismissed `TcpNotification` as JSON

| Flag                       | Description                 |
| -------------------------- | --------------------------- |
| `--notification-id <uuid>` | Required. Notification UUID |

```bash
./tcp-cli.sh -t $TOKEN dismiss-notification --notification-id <uuid>
```

### `dismiss-cap`

Lifts a provider's spend cap — until it next resets, or indefinitely — and
resumes the agents it paused. Administrators only.

- **stdout**: the updated `SpendCapState` as JSON

| Flag              | Description                                                  |
| ----------------- | ------------------------------------------------------------ |
| `--provider <id>` | Required. Catalogue provider id                              |
| `--indefinitely`  | Lift the cap until restored, instead of until its next reset |

```bash
./tcp-cli.sh -t $TOKEN dismiss-cap --provider lm-studio
./tcp-cli.sh -t $TOKEN dismiss-cap --provider anthropic --indefinitely
```

### `restore-cap`

Puts a lifted cap back into force, re-evaluating it straight away.
Administrators only.

- **stdout**: the updated `SpendCapState` as JSON

| Flag              | Description                     |
| ----------------- | ------------------------------- |
| `--provider <id>` | Required. Catalogue provider id |

```bash
./tcp-cli.sh -t $TOKEN restore-cap --provider lm-studio
```

### `resume-company`

Resumes every task in a company with agents paused by a spend cap, a shutdown
or a rate limit. A task a user paused with `pause-task` is left alone: resume
it with `resume-task`. Exempts the affected tasks from spend caps only while a
cap is reached. Does not lift the cap for any other company.

- **stdout**: `{ resumed }` as JSON

| Flag                        | Description                    |
| --------------------------- | ------------------------------ |
| `--company-id <id-or-slug>` | Required. Company UUID or slug |

```bash
./tcp-cli.sh -t $TOKEN resume-company --company-id acme
```

---

## Input shape: `DeepPartial<T>`

For `set-company` and `set-role`, the input JSON is typed as `DeepPartial<T>`:
a recursive partial where all nested objects are also optional. This allows
partial updates without providing every field.

```typescript
// Create (all required fields must be present)
{ "slug": "acme", "name": "Acme Corp" }

// Update (only provide what changes)
{ "id": "<uuid>", "name": "Acme Renamed" }
```
