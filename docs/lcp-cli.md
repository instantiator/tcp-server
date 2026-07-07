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

| Verb                                                    | Invocation                                                                                   | Description                                                                |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [`get-token`](#get-token)                               | `get-token`                                                                                  | Exchange username + password for an OIDC access token                      |
| [`list-companies`](#list-companies)                     | `list-companies`                                                                             | List all companies                                                         |
| [`list-roles`](#list-roles)                             | `list-roles [-c <uuid>\|--company-slug <slug>]`                                              | List roles, optionally filtered to one company                             |
| [`set-company`](#set-company)                           | `set-company [-c <uuid>\|--company-slug <slug>] [-i <json>]`                                 | Create or update a company                                                 |
| [`set-role`](#set-role)                                 | `set-role [-c <uuid>\|--company-slug <slug>] [-r <uuid>\|--role-slug <slug>] [-i <json>]`    | Create or update a role                                                    |
| [`delete-company`](#delete-company)                     | `delete-company (-c <uuid>\|--company-slug <slug>) [-f]`                                     | Delete a company and everything in it                                      |
| [`delete-role`](#delete-role)                           | `delete-role (-r <uuid>\|--role-slug <slug>) [-f]`                                           | Delete a role and everything tied to it                                    |
| [`chat`](#chat)                                         | `chat (-r <uuid>\|-c <uuid>) [-q <message>]`                                                 | Interactive or single-query chat with a role, or browse a company's roster |
| [`store-role-documents`](#store-role-documents)         | `store-role-documents (-r <uuid>\|--role-slug <slug>) -s <paths...>`                         | Upload OKF Markdown documents to a role's knowledge base                   |
| [`list-role-documents`](#list-role-documents)           | `list-role-documents (-r <uuid>\|--role-slug <slug>)`                                        | List knowledge-base documents stored for a role                            |
| [`remove-role-documents`](#remove-role-documents)       | `remove-role-documents (-r <uuid>\|--role-slug <slug>) -p <patterns...>`                     | Remove knowledge-base documents by filename pattern                        |
| [`open-document-store`](#open-document-store)           | `open-document-store [--no-open]`                                                            | Print (and open) the MinIO console URL                                     |
| [`list-open-queries`](#list-open-queries)               | `list-open-queries [-c <uuid>\|--company-slug <slug>] [--format table\|json\|csv]`           | List open agent-to-human queries                                           |
| [`read-query`](#read-query)                             | `read-query <slug>`                                                                          | Read a query's full question and conversation history                      |
| [`respond`](#respond)                                   | `respond <slug> <message>`                                                                   | Reply to a query and resume the waiting agent                              |
| [`download-shared-document`](#download-shared-document) | `download-shared-document --source <path> [--target <path>]`                                 | Download a file from shared company storage                                |
| [`upload-shared-document`](#upload-shared-document)     | `upload-shared-document --source <path> --target <path>`                                     | Upload a local file to shared company storage                              |
| [`estimate-context-window`](#estimate-context-window)   | `estimate-context-window [-c <uuid>\|--company-slug <slug>] [-r <uuid>\|--role-slug <slug>]` | Estimate a role's worst-case prompt token footprint                        |
| [`validate-shared-document`](#validate-shared-document) | `validate-shared-document --path <path\|glob> [--recursive]`                                 | Re-validate document(s) already in shared storage                          |

`--role-slug` requires `--company-id`/`--company-slug` alongside it — role slugs are unique only within a company, not globally.

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

- **stdout**: `{ id, name }[]` as JSON

```bash
./lcp-cli.sh -t $TOKEN list-companies
```

### `list-roles`

List roles grouped by company.

- **stdout**: `{ id, name, roles: { id, name }[] }[]` as JSON
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

Initiate a conversation with an agent running a given role — or, with `--company-id`
instead of `--role-id`, open the TUI on that company's role roster with no agent
started yet, and pick one there.

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

| Flag                  | Alias | Description                                                           |
| --------------------- | ----- | --------------------------------------------------------------------- |
| `--role-id <uuid>`    | `-r`  | Role UUID for the agent (omit to browse company roles instead)        |
| `--company-id <uuid>` | `-c`  | Company UUID — browse and start chats from its role roster (TUI only) |
| `--query <message>`   | `-q`  | Single question, auto-submitted on startup — requires `-r`            |
| `--hide-reasoning`    |       | Suppress the reasoning stream                                         |
| `--no-tui`            |       | Force the plain scrolling renderer, even on a TTY                     |

Exactly one of `--role-id`/`--company-id` is required. `--company-id` alone
needs the TUI's roster pane to pick a role, so it's rejected outside a TTY (or
with `--no-tui`) — pass `--role-id` directly for non-interactive use instead.

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

- **Agent state** (bright cyan) — lifecycle transitions: running, paused,
  resumed, completed.
- **LLM state** (bright magenta) — request start/finish and tool calls.
- **Reasoning** (grey, indented) — the model's reasoning tokens as they arrive,
  where the provider exposes them (e.g. LM Studio). Shown by default; suppress
  with `--hide-reasoning`.
- **Response** (white) — the answer content, streamed token by token.

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

### `store-role-documents`

Upload OKF Markdown documents to a role's knowledge base. All files are validated before any are uploaded — if any fail, none are sent.

Each file must be a `.md` file with valid YAML front-matter containing a non-empty `title` field (OKF format).

- **stdout**: JSON array of `{ key, name, size, lastModified }` for each uploaded document
- **stderr**: validation errors and per-file progress

| Flag                    | Alias | Description                                                      |
| ----------------------- | ----- | ---------------------------------------------------------------- |
| `--role-id <uuid>`      | `-r`  | Role UUID (required unless `--role-slug` is given)               |
| `--role-slug <slug>`    |       | Role slug instead of `--role-id` (requires a company identifier) |
| `--company-id <uuid>`   | `-c`  | Company UUID (for `--role-slug`)                                 |
| `--company-slug <slug>` |       | Company slug (for `--role-slug`)                                 |
| `--src <paths...>`      | `-s`  | **(Required)** One or more file paths to upload                  |

```bash
./lcp-cli.sh -t $TOKEN store-role-documents -r <roleId> -s policy.md handbook.md
./lcp-cli.sh -t $TOKEN store-role-documents --company-slug acme --role-slug analyst -s policy.md
```

Documents are stored in MinIO under `{company_slug}/knowledge/{role_name}/` and automatically indexed for RAG retrieval. See [shared-storage.md](shared-storage.md) for the storage layout.

### `list-role-documents`

List the knowledge-base documents currently stored for a role.

- **stdout**: JSON array of `{ key, name, size, lastModified }` — empty array if none stored

| Flag                    | Alias | Description                                                      |
| ----------------------- | ----- | ---------------------------------------------------------------- |
| `--role-id <uuid>`      | `-r`  | Role UUID (required unless `--role-slug` is given)               |
| `--role-slug <slug>`    |       | Role slug instead of `--role-id` (requires a company identifier) |
| `--company-id <uuid>`   | `-c`  | Company UUID (for `--role-slug`)                                 |
| `--company-slug <slug>` |       | Company slug (for `--role-slug`)                                 |

```bash
./lcp-cli.sh -t $TOKEN list-role-documents -r <roleId>
./lcp-cli.sh -t $TOKEN list-role-documents --company-slug acme --role-slug analyst
```

### `remove-role-documents`

Remove knowledge-base documents from a role by filename pattern. Supports `*` (any sequence of characters) and `?` (any single character) wildcards. Matched documents are deleted from MinIO and their RAG chunks removed from the database.

- **stdout**: JSON array of deleted document keys
- **stderr**: list of matched filenames before deletion, or a message if nothing matched

| Flag                      | Alias | Description                                                      |
| ------------------------- | ----- | ---------------------------------------------------------------- |
| `--role-id <uuid>`        | `-r`  | Role UUID (required unless `--role-slug` is given)               |
| `--role-slug <slug>`      |       | Role slug instead of `--role-id` (requires a company identifier) |
| `--company-id <uuid>`     | `-c`  | Company UUID (for `--role-slug`)                                 |
| `--company-slug <slug>`   |       | Company slug (for `--role-slug`)                                 |
| `--pattern <patterns...>` | `-p`  | **(Required)** One or more filename patterns (e.g. `"*.md"`)     |

```bash
# Remove a specific file
./lcp-cli.sh -t $TOKEN remove-role-documents -r <roleId> -p "handbook.md"

# Remove all markdown files
./lcp-cli.sh -t $TOKEN remove-role-documents -r <roleId> -p "*.md"

# Remove files matching multiple patterns
./lcp-cli.sh -t $TOKEN remove-role-documents -r <roleId> -p "policy-?.md" "archive-*.md"
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
