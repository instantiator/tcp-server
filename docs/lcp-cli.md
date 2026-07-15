# lcp-cli — Developer CLI Reference

`lcp-cli` is a TypeScript command-line tool for interacting with an LCP server.
It lives in `apps/lcp-cli/` and is launched via `./lcp-cli.sh` at the repository root.

## Quick start

```bash
# Build and run (auto-builds on first call)
./lcp-cli.sh --help

# Force rebuild before running
./lcp-cli.sh --rebuild list-companies
```

## Global options

These options apply to all verbs and must come before the verb name.

| Flag                           | Alias | Default                 | Description                                         |
| ------------------------------ | ----- | ----------------------- | --------------------------------------------------- |
| `--lcp-server <url>`           | `-s`  | `http://localhost:3000` | LCP server base URL                                 |
| `--access-token <token>`       | `-t`  | —                       | Bearer token (skips auth flow)                      |
| `--refresh-token <token>`      | `-T`  | —                       | Refresh token (renews an expired access token)      |
| `--access-token-env-var <var>` | `-e`  | —                       | Name of env var holding the token                   |
| `--username <user>`            | `-u`  | —                       | OIDC username (triggers server-side token exchange) |
| `--password <pass>`            | `-p`  | —                       | OIDC password (omit to be prompted interactively)   |

**Token resolution order**: `-t` → `-e` → username+password grant.

**Token renewal**: when `-t` or `-e` is used alongside `-T`, the refresh token is held in memory. Commands that run for a long time (e.g. `chat`) automatically exchange it for a new access token when the server returns `401 Unauthorized`, then retry the request transparently. When `-u` / `-p` is used instead, the server's own refresh token from the initial grant is used — no `-T` is needed.

## Authentication

lcp-cli needs a valid OIDC access token for most operations.
The server proxies the OIDC password grant so the client secret stays server-side.

```bash
# Interactive password prompt (characters masked)
./lcp-cli.sh -u alice get-token

# Non-interactive
./lcp-cli.sh -u alice -p secret get-token

# Use a token from an env var
export LCP_TOKEN=$(./lcp-cli.sh -u alice get-token)
./lcp-cli.sh -e LCP_TOKEN list-companies
```

## Validating JSON input

`set-company`, `set-role`, and similar commands accept a JSON payload. Before applying, validate it against the generated JSON Schema to catch missing required fields or type mismatches before they reach the server:

```bash
# Install ajv-cli once (global, not in devDependencies)
npm install -g ajv-cli

# Validate a company file
ajv validate -s schemas/schema.json --ref '#/definitions/LcpCompany' -d my-company.json

# Validate a role file
ajv validate -s schemas/schema.json --ref '#/definitions/LcpRole' -d my-role.json
```

See [schema.md](schema.md) for the full field reference, VS Code integration, example JSON, and an inline Node.js validation option that needs no extra install.

## Verbs

| Verb                                                    | Invocation                                                                                                          | Description                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [`get-token`](#get-token)                               | `get-token`                                                                                                         | Exchange username + password for an OIDC access token                      |
| [`list-companies`](#list-companies)                     | `list-companies`                                                                                                    | List all companies                                                         |
| [`list-roles`](#list-roles)                             | `list-roles [-c <uuid>\|--company-slug <slug>]`                                                                     | List roles, optionally filtered to one company                             |
| [`set-company`](#set-company)                           | `set-company [-c <uuid>\|--company-slug <slug>] [-i <json>]`                                                        | Create or update a company                                                 |
| [`set-role`](#set-role)                                 | `set-role [-c <uuid>\|--company-slug <slug>] [-r <uuid>\|--role-slug <slug>] [-i <json>]`                           | Create or update a role                                                    |
| [`delete-company`](#delete-company)                     | `delete-company (-c <uuid>\|--company-slug <slug>) [-f]`                                                            | Delete a company and everything in it                                      |
| [`delete-role`](#delete-role)                           | `delete-role (-r <uuid>\|--role-slug <slug>) [-f]`                                                                  | Delete a role and everything tied to it                                    |
| [`chat`](#chat)                                         | `chat (-r <uuid>\|--role-slug <slug>\|-c <uuid>\|--company-slug <slug>) [-q <message>]`                             | Interactive or single-query chat with a role, or browse a company's roster |
| [`list-knowledge`](#list-knowledge)                     | `list-knowledge (--role <slug-or-id>\|--company <slug-or-id>)`                                                      | List knowledge-base documents for a role or company (shared knowledge)     |
| [`get-knowledge`](#get-knowledge)                       | `get-knowledge (--role <slug-or-id>\|--company <slug-or-id>) -f <filename> [-o <path>]`                             | Get a knowledge-base document's content                                    |
| [`store-knowledge`](#store-knowledge)                   | `store-knowledge (--role <slug-or-id>\|--company <slug-or-id>) -s <path> [-t <filename>]`                           | Upload an OKF Markdown document to a role or company knowledge base        |
| [`delete-knowledge`](#delete-knowledge)                 | `delete-knowledge (--role <slug-or-id>\|--company <slug-or-id>) -f <filename>`                                      | Delete a knowledge-base document by filename                               |
| [`reindex-knowledge`](#reindex-knowledge)               | `reindex-knowledge --company <slug-or-id>`                                                                          | Force a full RAG rebuild of every knowledge scope of a company             |
| [`open-document-store`](#open-document-store)           | `open-document-store [--no-open]`                                                                                   | Print (and open) the MinIO console URL                                     |
| [`open-swagger`](#open-swagger)                         | `open-swagger --service <name> [--no-open]`                                                                         | Print (and open) a service's Swagger UI URL                                |
| [`list-open-queries`](#list-open-queries)               | `list-open-queries [-c <uuid>\|--company-slug <slug>] [--format table\|json\|csv]`                                  | List open agent-to-human queries                                           |
| [`read-query`](#read-query)                             | `read-query <slug>`                                                                                                 | Read a query's full question and conversation history                      |
| [`respond`](#respond)                                   | `respond <slug> <message>`                                                                                          | Reply to a query and resume the waiting agent                              |
| [`download-shared-document`](#download-shared-document) | `download-shared-document --source <path> [--target <path>]`                                                        | Download a file from shared company storage                                |
| [`upload-shared-document`](#upload-shared-document)     | `upload-shared-document --source <path> --target <path>`                                                            | Upload a local file to shared company storage                              |
| [`estimate-context-window`](#estimate-context-window)   | `estimate-context-window [-c <uuid>\|--company-slug <slug>] [-r <uuid>\|--role-slug <slug>]`                        | Estimate a role's worst-case prompt token footprint                        |
| [`validate-shared-document`](#validate-shared-document) | `validate-shared-document --path <path\|glob> [--recursive]`                                                        | Re-validate document(s) already in shared storage                          |
| [`create-task`](#create-task)                           | `create-task -c <slug-or-id> -r <text> [--planner-role <slug-or-id>] [-m <paths...>] [-e <filenames...>] [--start]` | Create a task, optionally uploading materials and starting it              |
| [`list-tasks`](#list-tasks)                             | `list-tasks -c <slug-or-id>`                                                                                        | List a company's tasks                                                     |
| [`get-task`](#get-task)                                 | `get-task --task-id <uuid>`                                                                                         | Get a task, including its assignment statuses and QA outcomes              |
| [`cancel-task`](#cancel-task)                           | `cancel-task --task-id <uuid>`                                                                                      | Cancel a task and its still-non-terminal assignments/agents                |
| [`list-agents`](#list-agents)                           | `list-agents (--role \| --company <slug-or-id>) [--filter k=v...]`                                                  | List agents for a role or company                                          |
| [`list-assignments`](#list-assignments)                 | `list-assignments (--task-id <uuid> \| --company <slug-or-id>) [--filter k=v...]`                                   | List assignments for a task or company                                     |
| [`eavesdrop`](#eavesdrop)                               | `eavesdrop (--agent-id \| --assignment-id \| --task-id <uuid>) [--show-history] [--tail]`                           | Replay and/or follow an agent's, assignment's, or task's activity          |

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

Exchange username + password for an OIDC access token.

- **stdout**: the raw access token string
- **stderr**: warning on failure
- **Requires**: `--username` (password prompted if `--password` omitted)

```bash
./lcp-cli.sh -u alice get-token
./lcp-cli.sh -u alice -p secret get-token
```

### `list-companies`

List all companies.

- **stdout**: `{ id, slug, name, description }[]` as JSON

```bash
./lcp-cli.sh -t $TOKEN list-companies
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
./lcp-cli.sh -t $TOKEN list-roles
./lcp-cli.sh -t $TOKEN list-roles -c <companyId>
./lcp-cli.sh -t $TOKEN list-roles --company-slug acme
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
| `--input <json>`        | `-i`  | JSON body (`DeepPartial<LcpCompany>`)               |

```bash
# Create
echo '{"slug":"acme","name":"Acme Corp"}' | ./lcp-cli.sh -t $TOKEN set-company

# Update (id present → PUT)
./lcp-cli.sh -t $TOKEN set-company -i '{"id":"<uuid>","name":"Acme Renamed"}'

# Update by slug, without needing to know the id
./lcp-cli.sh -t $TOKEN set-company --company-slug acme -i '{"name":"Acme Renamed"}'
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
| `--input <json>`        | `-i`  | JSON body (`DeepPartial<LcpRole>`)                                   |

```bash
# Create
./lcp-cli.sh -t $TOKEN set-role -c <companyId> \
  -i '{"slug":"analyst","name":"analyst","description":"...","systemPromptTemplate":"You are {{name}}."}'

# Update by slug, without needing to know the id
./lcp-cli.sh -t $TOKEN set-role --company-slug acme --role-slug analyst \
  -i '{"description":"Updated description."}'

# Update
./lcp-cli.sh -t $TOKEN set-role -i '{"id":"<uuid>","name":"senior-analyst"}'
```

#### Data-quality warnings

`set-company` and `set-role` (and their equivalent server routes) still
succeed when data is technically valid but inadvisable — e.g. a role with no
`knowledgeDomains`, or a blank `companyContext`/`rolePrompt`. The server
reports these via the `X-Lcp-Warnings` response header (a JSON array of
strings); the CLI prints each one to **stderr in yellow, prefixed with a
warning emoji**, so piping stdout elsewhere is unaffected:

```bash
$ ./lcp-cli.sh -t $TOKEN set-role -c <companyId> -i '{"slug":"analyst","name":"analyst","description":"..."}'
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
./lcp-cli.sh -t $TOKEN delete-company --company-slug acme
./lcp-cli.sh -t $TOKEN delete-company -c <companyId> --force
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
./lcp-cli.sh -t $TOKEN delete-role --company-slug acme --role-slug analyst
./lcp-cli.sh -t $TOKEN delete-role -r <roleId> --force
```

### `chat`

Initiate a conversation with an agent running a given role — or, with a
company instead of a role, open the TUI on that company's role roster with no
agent started yet, and pick one there.

Conversation history is maintained server-side in the LangGraph checkpoint store.
Every agent a chat session creates (the initial one, plus any started later from
the roster) is deleted when the session ends. If the access token expires
mid-session, it is renewed automatically using the refresh token (provided via
`-T` or obtained from the initial username+password grant).

If the agent consults another role mid-chat and that consultation fails (the consulted
agent errors, times out, or never calls `complete_task` despite reminders), the failure
is reported back to your agent, which decides how to proceed — you get a real answer
(possibly one that explains the failure) instead of the chat hanging until the timeout.

**How a turn works.** Sending a message returns `202 Accepted` immediately; the
turn runs on the server and everything it does is streamed back live over the
agent's Server-Sent Events stream (`GET /api/agent/:id/events`). The CLI opens
that stream and renders each event until the terminal `completed` (or
`failed`) event arrives — either in the full-screen TUI (default on a TTY) or
as colour-coded scrolling text (piped output, or `--no-tui`); see below.

**Following consultations.** When your agent pauses to consult another role,
the CLI automatically opens a second stream for the consulted agent and
renders its activity too — as its own tab in the TUI, or inline prefixed with
the consulted role's name (e.g. `[Cat assistant] Response: …`) in the plain
renderer. Nested consultations are followed recursively either way.

| Flag                    | Alias | Description                                                              |
| ----------------------- | ----- | ------------------------------------------------------------------------ |
| `--role-id <uuid>`      | `-r`  | Role UUID for the agent (omit to browse company roles instead)           |
| `--role-slug <slug>`    |       | Role slug instead of `--role-id` (needs `--company-id`/`--company-slug`) |
| `--company-id <uuid>`   | `-c`  | Company UUID — browse and start chats from its role roster (TUI only)    |
| `--company-slug <slug>` |       | Company slug instead of `--company-id`                                   |
| `--query <message>`     | `-q`  | Single question, auto-submitted on startup — requires a role             |
| `--hide-reasoning`      |       | Suppress the reasoning stream                                            |
| `--no-tui`              |       | Force the plain scrolling renderer, even on a TTY                        |

Exactly one of a role (`--role-id`, or `--role-slug` scoped to a company) or a
bare company (`--company-id`/`--company-slug`) is required — role slugs are
unique only within a company, not globally, so `--role-slug` needs one of the
company flags alongside it (`--role-id` is self-sufficient and can't be
combined with either). A bare company alone needs the TUI's roster pane to
pick a role, so it's rejected outside a TTY (or with `--no-tui`) — pass a role
directly for non-interactive use instead.

```bash
./lcp-cli.sh -t $TOKEN chat --company-slug acme --role-slug chicken-assistant --no-tui -q 'Tell me about yourself'
./lcp-cli.sh -t $TOKEN chat --company-slug acme   # browse the roster (TUI)
```

#### Full-screen TUI (default on a TTY)

When stdout is a real terminal, `chat` (both interactive and `-q`) opens a
full-screen view instead of scrolling text:

- **Pane 0 is always the company roster** — labelled with the company's name,
  opening with a `Slug: …` / `Id: …` heading and a "Please select a role to
  initiate a chat:" prompt, then a blank line, then the role list (the roster
  pane doesn't render role slugs yet, so the list is just role names, sorted
  alphabetically — see `--role-slug` elsewhere in this doc for scripted access
  by slug). **Up/Down** moves the highlight (the view scrolls to keep
  it visible on a long list), **Enter** starts a chat with the highlighted
  role (opening a new talkable tab and switching to it — this also works
  mid-session, so you can chat with more than one role at once), and **r**
  re-fetches the role list. It has no input box, so these keys are free for
  navigation rather than typing.
- **One tab per other monitored agent** — the root agent (if `-r` was given;
  it opens immediately alongside the roster and becomes active), one per role
  chatted with from the roster, and one per consultation any of them
  triggers, added live as `consultation_started` events arrive. Switch tabs
  with **Tab** / **Shift+Tab**; the active tab is shown in bold/bright colour.
  **Ctrl+W** closes the active tab (any tab except the roster, which is
  permanent) — for a talkable tab this also aborts its turn if one is in
  flight and deletes its agent; closing a consultation-follower tab just
  stops watching it. Closing the last agent tab leaves you back on the
  roster, the same state `--company-id` alone starts in.
- **Independent scrollback per tab** — each agent's events accumulate in its
  own pane, opening with a `Name: …` / `Id: …` heading identifying the role
  and its id; switching tabs doesn't lose or interleave another agent's
  output, unlike the plain renderer's single interleaved stream. Scroll with
  **PgUp/PgDn** (or the mouse wheel); scrolling up stops the view following
  new output, paging back to the bottom resumes it. On spectator tabs the
  arrow keys and Home/End scroll too. A blank row always separates the tab
  bar from a pane's content.
- **Input box only on talkable tabs** — the root agent's tab and any tab
  started from the roster show an input line (`> `); consultation tabs are
  spectate-only, and the roster tab has none (see above). This includes `-q`
  mode: the root tab's input is present but disabled while the query's turn
  is in flight, the same as any busy talkable tab (see below). **Enter**
  sends; **Alt+Enter** inserts a line break (Shift+Enter can't — terminals
  send the same byte for
  Shift+Enter and Enter); arrow keys, Home/End, and Backspace/Delete edit as
  usual. While a turn is in flight, that tab's input still accepts typing but
  won't submit until the response arrives (its hint row says `waiting for
response…`) — other tabs are unaffected and can run turns concurrently. A
  mid-typed draft survives switching tabs, tracked independently per tab.
  The terminal's own text cursor only ever appears on an enabled input box —
  it's hidden everywhere else (the roster, spectator tabs, a busy talkable
  tab), rather than lingering wherever it last was.
- Events render as `hh:mm:ss | event_type | text`, blank-line separated;
  reasoning deltas render specially — indented two spaces, no columns, grey,
  word-wrapped — with a blank line whenever reasoning is interrupted by
  another event or resumes afterwards.
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
./lcp-cli.sh -t $TOKEN chat -r <roleId>
# (full-screen TUI opens; type at the bottom input line, Tab/Shift+Tab to
# switch tabs if a consultation is in progress, Ctrl+C or 'exit' to leave)

./lcp-cli.sh -t $TOKEN chat -c <companyId>
# (opens straight onto the company's role roster — no agent yet; Up/Down to
# pick a role, Enter to start chatting)
```

#### Plain renderer (piped output, or `--no-tui`)

When stdout is piped/redirected, or `--no-tui` is passed, output stays as
colour-coded, blank-line-separated scrolling text — this is also the only
mode compatible with piping the final answer to another command:

- **You** (bright green, stderr) — the message you just sent, echoed before
  the turn starts, so a scrolled-back transcript shows what was asked as well
  as the answer.
- **Agent state** (bright cyan) — lifecycle transitions: running, paused,
  resumed, completed.
- **LLM state** (bright magenta) — request start/finish and tool calls.
- **Reasoning** (grey, indented) — the model's reasoning tokens as they arrive,
  where the provider exposes them (e.g. LM Studio). Shown by default; suppress
  with `--hide-reasoning`.
- **Response** (white) — the answer content, streamed token by token. A
  whitespace-only or empty response renders as `(blank)` rather than nothing,
  so it's obvious the agent genuinely returned no content.

**Single-query mode** (`-q` provided, piped or `--no-tui`):

- **stdout**: the agent's final response (once, so the output stays pipeable)
- **stderr**: the live streamed blocks (state, reasoning, response progress)
- Creates agent → sends message → streams the turn → prints the answer → deletes agent → exits

```bash
./lcp-cli.sh -t $TOKEN chat -r <roleId> -q "What is your role?" | tee answer.txt
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
./lcp-cli.sh -t $TOKEN chat -r <roleId> --no-tui
# > Tell me about Q3 trends.
#
# You: Tell me about Q3 trends.
#
# Agent state: running
#
# Reasoning: the user wants a summary of…
#
# Response: Q3 revenue rose 12% driven by…
#
# Agent state: completed
# > exit
# Agent <id> removed.
```

### `list-knowledge`

List the knowledge-base documents currently stored for a role, or for a company's shared knowledge.

- **stdout**: JSON array of `{ key, name, size, lastModified }` — empty array if none stored

| Flag                     | Alias | Description                                   |
| ------------------------ | ----- | --------------------------------------------- |
| `--role <slug-or-id>`    | `-r`  | Role slug or UUID                             |
| `--company <slug-or-id>` | `-c`  | Company slug or UUID (shared knowledge scope) |

```bash
./lcp-cli.sh -t $TOKEN list-knowledge -r <roleId>
./lcp-cli.sh -t $TOKEN list-knowledge --company acme --role analyst
./lcp-cli.sh -t $TOKEN list-knowledge -c acme
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
./lcp-cli.sh -t $TOKEN get-knowledge -r <roleId> -f policy.md
./lcp-cli.sh -t $TOKEN get-knowledge -c acme -f handbook.md -o ./handbook.md
```

### `store-knowledge`

Upload (or overwrite) a single OKF Markdown document into a role's knowledge base, or a company's shared knowledge. The file is validated before upload — if it fails, nothing is sent.

The file must be a `.md` file with valid YAML front-matter containing a non-empty `title` field (OKF format).

- **stdout**: JSON `{ key, name, size, lastModified }` for the stored document
- **stderr**: validation errors and upload progress

| Flag                     | Alias | Description                                            |
| ------------------------ | ----- | ------------------------------------------------------ |
| `--role <slug-or-id>`    | `-r`  | Role slug or UUID                                      |
| `--company <slug-or-id>` | `-c`  | Company slug or UUID (shared knowledge scope)          |
| `--source <path>`        | `-s`  | **(Required)** Local Markdown file path to upload      |
| `--target <filename>`    | `-t`  | Filename to store as (defaults to the source filename) |

```bash
./lcp-cli.sh -t $TOKEN store-knowledge -r <roleId> -s policy.md
./lcp-cli.sh -t $TOKEN store-knowledge --company acme --role analyst -s policy.md
./lcp-cli.sh -t $TOKEN store-knowledge -c acme -s ./handbook.md -t company-handbook.md
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
./lcp-cli.sh -t $TOKEN delete-knowledge -r <roleId> -f policy.md
./lcp-cli.sh -t $TOKEN delete-knowledge -c acme -f handbook.md
```

### `reindex-knowledge`

Force a full RAG rebuild of every knowledge scope of a company (shared plus every role). Embeddings normally stay in sync automatically — via a write hook on every knowledge write and a background reconciliation poller (see [shared-storage.md → Automatic RAG sync](shared-storage.md#automatic-rag-sync-01022)). Use this to rebuild immediately after editing files directly in the MinIO console, rather than waiting for the poller. The server responds `202 Accepted` and rebuilds asynchronously.

- **stdout**: JSON `{ reindexing: true }`

| Flag                     | Alias | Description                         |
| ------------------------ | ----- | ----------------------------------- |
| `--company <slug-or-id>` | `-c`  | **(Required)** Company slug or UUID |

```bash
./lcp-cli.sh -t $TOKEN reindex-knowledge -c acme
```

### `open-document-store`

Print the MinIO console URL and open it in the default browser. Useful for browsing stored files during development.

- **stdout**: the console URL
- The URL is read from the `MINIO_CONSOLE_URL` environment variable (default: `http://localhost:9001`)

| Flag        | Description                      |
| ----------- | -------------------------------- |
| `--no-open` | Print the URL without opening it |

```bash
# Open in browser
./lcp-cli.sh open-document-store

# Print URL only
./lcp-cli.sh open-document-store --no-open
```

No authentication required — the MinIO console has its own login (see [shared-storage.md → Authentication](shared-storage.md#authentication)).

---

### `open-swagger`

Print the Swagger UI URL for one of the six server apps and open it in the default browser.

- **stdout**: the Swagger UI URL (`{base}/swagger`)
- Base URLs come from `LCP_<SERVICE>_BROWSER_URL` env vars (Docker-internal `LCP_*_URL` values aren't reachable from the host browser), defaulting to `http://localhost:<port>`

| Flag               | Description                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `--service <name>` | **(Required)** `lcp-server \| lcp-agent \| lcp-mcp-storage \| lcp-mcp-memory \| lcp-mcp-interactions \| lcp-mcp-tasks` |
| `--no-open`        | Print the URL without opening it                                                                                       |

```bash
./lcp-cli.sh open-swagger --service lcp-server

# Print URL only
./lcp-cli.sh open-swagger --service lcp-mcp-tasks --no-open
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
./lcp-cli.sh list-open-queries

# Filter to a company, JSON output
./lcp-cli.sh -e LCP_TOKEN list-open-queries -c <companyId> --format json

# Filter to a company by slug
./lcp-cli.sh -e LCP_TOKEN list-open-queries --company-slug acme
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
./lcp-cli.sh read-query analyst-3
```

---

### `respond`

Reply to an open query. Once submitted, the waiting agent is automatically re-enqueued and will resume with your reply injected as a `HumanMessage`. (If the agent raised several requests before pausing — e.g. a consultation and a user query — it resumes only once all of them are resolved, and sees every response at once.)

- **stdout**: `{ slug, status }` JSON
- **stderr**: progress messages (`"Sending response..."`, `"Agent resumed."`)

```bash
./lcp-cli.sh respond analyst-3 "The budget is $50,000 for Q3."
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
./lcp-cli.sh download-shared-document --source acme/tasks/xyz/output/report.md

# Download to a specific path
./lcp-cli.sh download-shared-document --source acme/tasks/xyz/output/report.md --target ~/Desktop/report.md
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
./lcp-cli.sh upload-shared-document --source ./architecture.md --target acme/knowledge/architect/architecture.md
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
| `--expected <filenames...>`   |       | Filenames expected in the task's completed directory              |
| `--start`                     |       | Start the task immediately after creation (and materials upload)  |

> [!NOTE]
> `--planner-role`/`--expected` have no short alias: `-p` collides with the
> global `-p, --password` (Commander silently binds the subcommand's `-p` to
> the root option instead — the password ends up overwritten by whatever
> `-p` value follows the subcommand), and `-e` is claimed by `./lcp-cli.sh`'s
> own `-e`/`--env` wrapper flag before the argument list ever reaches Node.

```bash
./lcp-cli.sh -t $TOKEN create-task -c acme -r "Write a market analysis report" --expected report.md

./lcp-cli.sh -t $TOKEN create-task -c acme -r "Summarise the attached brief" \
  -m ./brief.pdf --planner-role planner --start
```

### `list-tasks`

Lists a company's tasks.

- **stdout**: `LcpTask[]` as JSON

```bash
./lcp-cli.sh -t $TOKEN list-tasks -c acme
```

### `get-task`

Retrieves a task with its assignments (ordered: implement-mode plan
assignments by `orderIndex`, then the rest by creation time), including QA
outcomes.

- **stdout**: `{ task, assignments }` as JSON

```bash
./lcp-cli.sh -t $TOKEN get-task --task-id <uuid>
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
./lcp-cli.sh -t $TOKEN cancel-task --task-id <uuid>
```

### `list-agents`

Lists agents for a role or a company, defaulting to currently active agents
(`idle`, `running`, `paused`) unless `--filter status=` overrides it.

- **stdout**: `LcpAgent[]` as JSON

| Flag                               | Description                                                |
| ---------------------------------- | ---------------------------------------------------------- |
| `--role`/`--role-id`/`--role-slug` | Role to filter to (any variant)                            |
| `--company`/`-id`/`-slug`          | Company to filter to (any variant)                         |
| `--filter status=<status>`         | Repeatable. Overrides the default active-status filter     |
| `--filter role=<slug-or-id>`       | Repeatable. Overrides the top-level role scope             |
| `--filter assignment=<id>`         | Repeatable. Filter to agents working a specific assignment |

```bash
./lcp-cli.sh -t $TOKEN list-agents --company acme
./lcp-cli.sh -t $TOKEN list-agents --role analyst --company acme --filter status=paused
```

### `list-assignments`

Lists assignments for a task or a company.

- **stdout**: `LcpAssignment[]` as JSON

| Flag                         | Description                                                               |
| ---------------------------- | ------------------------------------------------------------------------- |
| `--task-id <uuid>`           | Task to list assignments for                                              |
| `--company`/`-id`/`-slug`    | Company to list assignments for (any variant)                             |
| `--filter status=<status>`   | Repeatable                                                                |
| `--filter task=<task-id>`    | Repeatable. Overrides `--task-id`                                         |
| `--filter task=null`         | Repeatable. Lists orphan assignments (plain conversations, consultations) |
| `--filter role=<slug-or-id>` | Repeatable                                                                |

```bash
./lcp-cli.sh -t $TOKEN list-assignments --task-id <uuid>
./lcp-cli.sh -t $TOKEN list-assignments --company acme --filter task=null
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

- **stdout** (`--show-history`): one `hh:mm:ss | eventType | summary` line per
  recorded audit event, oldest first
- **stdout/stderr** (`--tail`): rendered the same way `chat`'s plain renderer
  renders its own agent's stream
- `--tail` warns and exits non-zero if the target has already finished (or,
  for `--assignment-id`, hasn't started yet — nothing to follow)
- `--task-id` history/tail covers the task's own assignments only; a
  consultation spawned mid-assignment is a separate orphan assignment with no
  link back to the task, so it isn't traced (eavesdrop directly on that
  consultation's `--assignment-id`/`--agent-id` instead, once you have its id
  from `list-assignments --filter task=null`)

```bash
# Replay everything that happened on a task so far
./lcp-cli.sh -t $TOKEN eavesdrop --task-id <uuid> --show-history

# Watch a still-running assignment live
./lcp-cli.sh -t $TOKEN eavesdrop --assignment-id <uuid> --tail

# Both: catch up, then keep watching
./lcp-cli.sh -t $TOKEN eavesdrop --agent-id <uuid> --show-history --tail
```

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
./lcp-cli.sh estimate-context-window --company-slug acme --role-slug analyst

# Full breakdown, without hitting a live server
./lcp-cli.sh estimate-context-window --from-file ./role-fixture.json --json
```

### `validate-shared-document`

Re-validates document(s) already in shared storage against the same rules
enforced when lcp-server writes a document (JSON/YAML/OKF Markdown/plain
Markdown/XML/CSV — see [shared-storage.md](shared-storage.md#write-validation)).
Exists because a user could write directly to the backing object store,
bypassing lcp-server's write-time validation gate entirely — this gives an
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
./lcp-cli.sh validate-shared-document --path acme/knowledge/analyst/report.md

# Validate every document under a role's knowledge base, including subfolders
./lcp-cli.sh validate-shared-document --path "acme/knowledge/analyst/*" --recursive
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
