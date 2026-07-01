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

| Verb                                                    | Invocation                                                   | Description                                              |
| ------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| [`get-token`](#get-token)                               | `get-token`                                                  | Exchange username + password for an OIDC access token    |
| [`list-companies`](#list-companies)                     | `list-companies`                                             | List all companies                                       |
| [`list-roles`](#list-roles)                             | `list-roles [-c <uuid>]`                                     | List roles, optionally filtered to one company           |
| [`set-company`](#set-company)                           | `set-company [-i <json>]`                                    | Create or update a company                               |
| [`set-role`](#set-role)                                 | `set-role -c <uuid> [-i <json>]`                             | Create or update a role                                  |
| [`chat`](#chat)                                         | `chat -r <uuid> [-q <message>]`                              | Interactive or single-query chat with a role             |
| [`store-role-documents`](#store-role-documents)         | `store-role-documents -r <uuid> -s <paths...>`               | Upload OKF Markdown documents to a role's knowledge base |
| [`list-role-documents`](#list-role-documents)           | `list-role-documents -r <uuid>`                              | List knowledge-base documents stored for a role          |
| [`remove-role-documents`](#remove-role-documents)       | `remove-role-documents -r <uuid> -p <patterns...>`           | Remove knowledge-base documents by filename pattern      |
| [`open-document-store`](#open-document-store)           | `open-document-store [--no-open]`                            | Print (and open) the MinIO console URL                   |
| [`list-open-queries`](#list-open-queries)               | `list-open-queries [-c <uuid>] [--format table\|json\|csv]`  | List open agent-to-human queries                         |
| [`read-query`](#read-query)                             | `read-query <slug>`                                          | Read a query's full question and conversation history    |
| [`respond`](#respond)                                   | `respond <slug> <message>`                                   | Reply to a query and resume the waiting agent            |
| [`download-shared-document`](#download-shared-document) | `download-shared-document --source <path> [--target <path>]` | Download a file from shared company storage              |
| [`upload-shared-document`](#upload-shared-document)     | `upload-shared-document --source <path> --target <path>`     | Upload a local file to shared company storage            |

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

| Flag                  | Alias | Description                |
| --------------------- | ----- | -------------------------- |
| `--company-id <uuid>` | `-c`  | Filter to a single company |

```bash
./lcp-cli.sh -t $TOKEN list-roles
./lcp-cli.sh -t $TOKEN list-roles -c <companyId>
```

### `set-company`

Create or update a company. Reads JSON from `--input` or stdin.

- **stdout**: the created/updated company as JSON
- **stderr**: progress/errors
- If the input JSON contains `id`, performs an update (`PUT`); otherwise creates (`POST`)

| Flag             | Alias | Description                           |
| ---------------- | ----- | ------------------------------------- |
| `--input <json>` | `-i`  | JSON body (`DeepPartial<LcpCompany>`) |

```bash
# Create
echo '{"slug":"acme","name":"Acme Corp"}' | ./lcp-cli.sh -t $TOKEN set-company

# Update (id present → PUT)
./lcp-cli.sh -t $TOKEN set-company -i '{"id":"<uuid>","name":"Acme Renamed"}'
```

### `set-role`

Create or update a role. Reads JSON from `--input` or stdin.

- **stdout**: the created/updated role as JSON
- **stderr**: progress/errors
- If the input JSON contains `id`, performs an update (`PUT`); otherwise creates (`POST`)

| Flag                  | Alias | Description                                      |
| --------------------- | ----- | ------------------------------------------------ |
| `--company-id <uuid>` | `-c`  | Company UUID (required when creating a new role) |
| `--input <json>`      | `-i`  | JSON body (`DeepPartial<LcpRole>`)               |

```bash
# Create
./lcp-cli.sh -t $TOKEN set-role -c <companyId> \
  -i '{"name":"analyst","description":"...","systemPromptTemplate":"You are {{name}}."}'

# Update
./lcp-cli.sh -t $TOKEN set-role -i '{"id":"<uuid>","name":"senior-analyst"}'
```

### `chat`

Initiate a conversation with an agent running a given role.

Conversation history is maintained server-side in the LangGraph checkpoint store.
Each chat session creates a new agent record; the agent is deleted when the session ends.
If the access token expires mid-session, it is renewed automatically using the refresh token
(provided via `-T` or obtained from the initial username+password grant).

| Flag                | Alias | Description                            |
| ------------------- | ----- | -------------------------------------- |
| `--role-id <uuid>`  | `-r`  | **(Required)** Role UUID for the agent |
| `--query <message>` | `-q`  | Single question (non-interactive)      |

**Single-query mode** (`-q` provided):

- **stdout**: the agent's response
- **stderr**: status messages
- Creates agent → sends message → prints response → deletes agent → exits

```bash
./lcp-cli.sh -t $TOKEN chat -r <roleId> -q "What is your role?"
```

**Interactive mode** (no `-q`):

- Enters a readline prompt (`> `)
- User types messages; the agent's response is written to stdout
- Type `exit` or `quit`, or press Ctrl+C to end the session
- The agent is always cleaned up on exit (even on interrupt)

```bash
./lcp-cli.sh -t $TOKEN chat -r <roleId>
# > Hello!
# Hello! I am the analyst agent. How can I help?
# > Tell me about Q3 trends.
# ...
# > exit
# Agent <id> removed.
```

### `store-role-documents`

Upload OKF Markdown documents to a role's knowledge base. All files are validated before any are uploaded — if any fail, none are sent.

Each file must be a `.md` file with valid YAML front-matter containing a non-empty `title` field (OKF format).

- **stdout**: JSON array of `{ key, name, size, lastModified }` for each uploaded document
- **stderr**: validation errors and per-file progress

| Flag               | Alias | Description                                     |
| ------------------ | ----- | ----------------------------------------------- |
| `--role-id <uuid>` | `-r`  | **(Required)** Role UUID                        |
| `--src <paths...>` | `-s`  | **(Required)** One or more file paths to upload |

```bash
./lcp-cli.sh -t $TOKEN store-role-documents -r <roleId> -s policy.md handbook.md
```

Documents are stored in MinIO under `{company_slug}/knowledge/{role_name}/` and automatically indexed for RAG retrieval. See [shared-storage.md](shared-storage.md) for the storage layout.

### `list-role-documents`

List the knowledge-base documents currently stored for a role.

- **stdout**: JSON array of `{ key, name, size, lastModified }` — empty array if none stored

| Flag               | Alias | Description              |
| ------------------ | ----- | ------------------------ |
| `--role-id <uuid>` | `-r`  | **(Required)** Role UUID |

```bash
./lcp-cli.sh -t $TOKEN list-role-documents -r <roleId>
```

### `remove-role-documents`

Remove knowledge-base documents from a role by filename pattern. Supports `*` (any sequence of characters) and `?` (any single character) wildcards. Matched documents are deleted from MinIO and their RAG chunks removed from the database.

- **stdout**: JSON array of deleted document keys
- **stderr**: list of matched filenames before deletion, or a message if nothing matched

| Flag                      | Alias | Description                                                  |
| ------------------------- | ----- | ------------------------------------------------------------ |
| `--role-id <uuid>`        | `-r`  | **(Required)** Role UUID                                     |
| `--pattern <patterns...>` | `-p`  | **(Required)** One or more filename patterns (e.g. `"*.md"`) |

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
| `--format <fmt>`        | `table` (default), `json`, or `csv` |

```bash
# Default table output
./lcp-cli.sh list-open-queries

# Filter to a company, JSON output
./lcp-cli.sh -e LCP_TOKEN list-open-queries -c <companyId> --format json
```

The table columns are: slug, role name, and the first 120 characters of the question.

---

### `read-query`

Read the full question, context, and reply history for a single query by its slug.

- **stdout**: full conversation content
- **stderr**: progress messages

```bash
./lcp-cli.sh read-query analyst-3
```

---

### `respond`

Reply to an open query. Once submitted, the waiting agent is automatically re-enqueued and will resume with your reply injected as a `HumanMessage`.

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
