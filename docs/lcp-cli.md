# lcp-cli — Developer CLI Reference

`lcp-cli` is a TypeScript command-line tool for interacting with an LCP server.
It lives in `apps/lcp-cli/` and is launched via `scripts/dev/lcp-cli.sh`.

## Quick start

```bash
# Build and run (auto-builds on first call)
./scripts/dev/lcp-cli.sh --help

# Force rebuild before running
./scripts/dev/lcp-cli.sh --rebuild list-companies
```

## Global options

These options apply to all verbs and must come before the verb name.

| Flag                           | Alias | Default                 | Description                                         |
| ------------------------------ | ----- | ----------------------- | --------------------------------------------------- |
| `--lcp-server <url>`           | `-s`  | `http://localhost:3000` | LCP server base URL                                 |
| `--access-token <token>`       | `-t`  | —                       | Bearer token (skips auth flow)                      |
| `--access-token-env-var <var>` | `-e`  | —                       | Name of env var holding the token                   |
| `--username <user>`            | `-u`  | —                       | OIDC username (triggers server-side token exchange) |
| `--password <pass>`            | `-p`  | —                       | OIDC password (omit to be prompted interactively)   |

**Token resolution order**: `-t` → `-e` → username+password grant.

## Authentication

lcp-cli needs a valid OIDC access token for most operations.
The server proxies the OIDC password grant so the client secret stays server-side.

```bash
# Interactive password prompt (characters masked)
./scripts/dev/lcp-cli.sh -u alice get-token

# Non-interactive
./scripts/dev/lcp-cli.sh -u alice -p secret get-token

# Use a token from an env var
export LCP_TOKEN=$(./scripts/dev/lcp-cli.sh -u alice get-token)
./scripts/dev/lcp-cli.sh -e LCP_TOKEN list-companies
```

## Verbs

### `get-token`

Exchange username + password for an OIDC access token.

- **stdout**: the raw access token string
- **stderr**: warning on failure
- **Requires**: `--username` (password prompted if `--password` omitted)

```bash
./scripts/dev/lcp-cli.sh -u alice get-token
./scripts/dev/lcp-cli.sh -u alice -p secret get-token
```

### `list-companies`

List all companies.

- **stdout**: `{ id, name }[]` as JSON

```bash
./scripts/dev/lcp-cli.sh -t $TOKEN list-companies
```

### `list-roles`

List roles grouped by company.

- **stdout**: `{ id, name, roles: { id, name }[] }[]` as JSON
- **stderr**: progress/errors

| Flag                  | Alias | Description                |
| --------------------- | ----- | -------------------------- |
| `--company-id <uuid>` | `-c`  | Filter to a single company |

```bash
./scripts/dev/lcp-cli.sh -t $TOKEN list-roles
./scripts/dev/lcp-cli.sh -t $TOKEN list-roles -c <companyId>
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
echo '{"slug":"acme","name":"Acme Corp"}' | ./scripts/dev/lcp-cli.sh -t $TOKEN set-company

# Update (id present → PUT)
./scripts/dev/lcp-cli.sh -t $TOKEN set-company -i '{"id":"<uuid>","name":"Acme Renamed"}'
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
./scripts/dev/lcp-cli.sh -t $TOKEN set-role -c <companyId> \
  -i '{"name":"analyst","description":"...","systemPromptTemplate":"You are {{name}}."}'

# Update
./scripts/dev/lcp-cli.sh -t $TOKEN set-role -i '{"id":"<uuid>","name":"senior-analyst"}'
```

### `chat`

Initiate a conversation with an agent running a given role.

Conversation history is maintained server-side in the LangGraph checkpoint store.
Each chat session creates a new agent record; the agent is deleted when the session ends.

| Flag                | Alias | Description                            |
| ------------------- | ----- | -------------------------------------- |
| `--role-id <uuid>`  | `-r`  | **(Required)** Role UUID for the agent |
| `--query <message>` | `-q`  | Single question (non-interactive)      |

**Single-query mode** (`-q` provided):

- **stdout**: the agent's response
- **stderr**: status messages
- Creates agent → sends message → prints response → deletes agent → exits

```bash
./scripts/dev/lcp-cli.sh -t $TOKEN chat -r <roleId> -q "What is your role?"
```

**Interactive mode** (no `-q`):

- Enters a readline prompt (`> `)
- User types messages; the agent's response is written to stdout
- Type `exit` or `quit`, or press Ctrl+C to end the session
- The agent is always cleaned up on exit (even on interrupt)

```bash
./scripts/dev/lcp-cli.sh -t $TOKEN chat -r <roleId>
# > Hello!
# Hello! I am the analyst agent. How can I help?
# > Tell me about Q3 trends.
# ...
# > exit
# Agent <id> removed.
```

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
