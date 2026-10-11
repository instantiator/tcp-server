# Section 6 — MCP Servers

[← Back to start](./start.md#sections)

> **Requires:** Section 1 complete — Docker stack running. Section 5 recommended (storage operations are more interesting with files present).

You are testing the six MCP (Model Context Protocol) servers. Each exposes an HTTP endpoint that agents use to call tools at runtime. The servers use a stateless request-per-connection model: a fresh MCP session is created for every tool call.

The six servers are:

- **tcp-mcp-storage** (port 3010) — shared-storage exploration plus assignment-scoped working files and materials. Holds no S3 client: it proxies to tcp-server.
- **tcp-mcp-memory** (port 3011) — `recall`, `remember`, `search_knowledge`, over pgvector. The only one with its own database connection.
- **tcp-mcp-interactions** (port 3012) — `request_user_input`, `request_agent_consultation`, `list_available_contacts`. Proxies to tcp-server.
- **tcp-mcp-tasks** (port 3013) — `create_plan`, `complete_assignment`, `assure_assignment`, gated to the caller's mode. Proxies to tcp-server.
- **tcp-mcp-utilities** (port 3014) — `calculate`, `date_math`, `convert_units`. Stateless: no database, no calls to other services.
- **tcp-mcp-records** (port 3015) — `create_table`, `insert`, `update`, `delete`, `query`, `aggregate`. Has its own database connection and audits every read and change.

> The MCP servers are internal-only unless the stack was started with
> `./scripts/start-deployment.sh --dev-ports`. Start it that way before running
> this section's `curl`s against `localhost`.

```mermaid
sequenceDiagram
    participant A as tcp-agent
    participant C as McpClientService
    participant S as tcp-mcp-storage :3010
    participant TS as tcp-server
    participant MIO as MinIO

    A->>C: loadTools(["storage"], urls)
    C->>S: POST /mcp (initialize + listTools)
    S-->>C: tool list
    C-->>A: DynamicStructuredTool[] (agentId/companyId stripped from the schema)

    A->>C: invoke storage__list_files
    C->>S: POST /mcp (callTool: list_files, agentId injected)
    S->>TS: POST /internal/storage/list (X-Internal-Api-Key)
    TS->>MIO: ListObjectsV2
    MIO-->>TS: file list
    TS-->>S: JSON result
    S-->>C: JSON result
    C-->>A: text response
```

---

## 6.1 — Health checks

Each MCP server exposes a `GET /health` endpoint.

```bash
curl -s http://localhost:3010/health
curl -s http://localhost:3011/health
curl -s http://localhost:3012/health
curl -s http://localhost:3014/health
curl -s http://localhost:3015/health
```

Expected response for each (status 200):

```json
{ "status": "ok" }
```

---

## 6.2 — List tools on the storage server

Send an MCP `initialize + tools/list` request to the storage server. This is what tcp-agent does when loading tools for a role that includes `"storage"` in its `mcpServerList`.

```bash
curl -s -X POST http://localhost:3010/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": { "name": "manual-test", "version": "0.0.1" }
    }
  }' | jq '.result.serverInfo'
```

Expected:

| Field     | Expected            |
| --------- | ------------------- |
| `name`    | `"tcp-mcp-storage"` |
| `version` | `"1.0.0"`           |

Then list tools:

```bash
curl -s -X POST http://localhost:3010/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {}
  }' | jq '[.result.tools[].name]'
```

Expected tool list:

| Tool                                                                                                                                                                                                                                 | Description                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `describe_server`                                                                                                                                                                                                                    | Returns an overview of the storage service                                 |
| `describe_folder`                                                                                                                                                                                                                    | Explains the purpose of a folder by path prefix                            |
| `list_files` / `read_file` / `search_files`                                                                                                                                                                                          | Read-only exploration of the caller's own company (needs a real `agentId`) |
| `get_file_properties` / `get_file_summary`                                                                                                                                                                                           | File metadata / structural summary                                         |
| `list_working_files` / `read_working_file` / `create_working_file` / `append_working_file` / `replace_in_working_file` / `delete_working_file` / `restore_working_file` / `get_working_file_properties` / `get_working_file_summary` | Assignment-scoped working files (filename-only; require an `agentId`)      |
| `list_material_files` / `read_material_file` / `get_material_file_properties`                                                                                                                                                        | Assignment-scoped materials (require an `agentId`)                         |

> The `*_working_file` and `*_material_file` tools take an `agentId` that in production is injected by `McpClientService` and resolved server-side to a working directory. A bare `curl` has no agent context, so the sections below use the read-only exploration tools, which only need the `id` of a real agent in your company (they look up its company from it and stay inside that company's folder). Drive the working-file, material and resource tools through a real agent run instead.

---

## 6.3 — Call `describe_server`

```bash
curl -s -X POST http://localhost:3010/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "describe_server",
      "arguments": {}
    }
  }' | jq -r '.result.content[0].text'
```

Expected: a markdown overview of the storage service listing all tools and path conventions.

This is the tool an agent calls when it first connects to a server to learn what is available and how to use it — analogous to reading a man page before running commands.

---

## 6.4 — Call `describe_folder`

```bash
curl -s -X POST http://localhost:3010/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "tools/call",
    "params": {
      "name": "describe_folder",
      "arguments": { "path": "acme/tasks/123/output" }
    }
  }' | jq -r '.result.content[0].text'
```

Expected: a description of the `output` folder — something like "Task output — Files created during task execution. This is your working area..."

Try different path prefixes and observe the canned descriptions:

| Path                       | Expected description topic            |
| -------------------------- | ------------------------------------- |
| `acme/tasks/abc/materials` | Task materials — read-only inputs     |
| `acme/tasks/abc/output`    | Task output — agent working area      |
| `acme/knowledge/analyst`   | Knowledge base — RAG source documents |
| `acme/finished/reports`    | Finished reports — stable artefacts   |
| `acme/audit/abc`           | Audit log — append-only JSONL         |

---

## 6.5 — List files in MinIO via MCP

If you uploaded a document in Section 5, you can retrieve it through the storage MCP server:

```bash
# AGENT_ID is the id of any agent in your company. Paths are relative to the
# company folder; the full key (acme/knowledge) works too.
curl -s -X POST http://localhost:3010/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 5,
    "method": "tools/call",
    "params": {
      "name": "list_files",
      "arguments": { "agentId": "'$AGENT_ID'", "path": "knowledge" }
    }
  }' | jq -r '.result.content[0].text'
```

Expected: a JSON array of file entries including `test-knowledge.md`.

| Field          | Expected                                                         |
| -------------- | ---------------------------------------------------------------- |
| `key`          | Full object key, e.g. `acme/knowledge/analyst/test-knowledge.md` |
| `size`         | File size in bytes (> 0)                                         |
| `lastModified` | ISO 8601 timestamp                                               |

---

## 6.6 — Read a file via MCP

Read back a document you uploaded in Section 5 through the read-only `read_file` tool (agent writes go through the assignment-scoped `append_working_file` tool, which needs a real agent context — see the note in 6.2):

```bash
# Read (replace the key with one from the 6.5 listing)
curl -s -X POST http://localhost:3010/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 7,
    "method": "tools/call",
    "params": {
      "name": "read_file",
      "arguments": { "agentId": "'$AGENT_ID'", "path": "knowledge/analyst/test-knowledge.md" }
    }
  }' | jq -r '.result.content[0].text'
```

Expected: the file's text content, or `File not found: {path}` if the key does not exist.

---

## 6.7 — Verify the memory server searches for real

`recall` runs a live pgvector query, so this needs a company with an
`embeddingConfig` and some indexed knowledge (Section 5).

```bash
curl -s -X POST http://localhost:3011/mcp \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{
        \"name\":\"recall\",
        \"arguments\":{\"roleId\":\"$ROLE_ID\",\"companyId\":\"$COMPANY_ID\",\"query\":\"remote work policy\"}}}" \
  | jq -r '.result.content[0].text'
```

Expected: matching chunks with their cosine similarity scores, or a "no results"
message if nothing clears the threshold. With no `embeddingConfig` on the
company, expect a message directing the agent to the RAG context in its prompt
instead — that is the one remaining "not implemented"-shaped response, and it
means "not configured", not "not built".

---

## 6.8 — Check the utilities server

The utilities server needs no setup. Call `calculate` with a sum that floats get wrong:

```bash
curl -s -X POST http://localhost:3014/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"calculate","arguments":{"expression":"round(3 * 4.99 * 1.2, 2)"}}}'
```

Expected: the result text is `17.96`.

Then try a bad input, `"expression": "1 / 0"`. Expected: an error result (`isError: true`) saying division by zero is not allowed. The call itself does not fail.

Try `date_math` with `{"operation":"add","date":"2026-01-31","months":1}`. Expected: `{"result":"2026-02-28","clamped":true}`.

---

## 6.9 — Check the records server

The records server needs a company, because every table belongs to one. Use the id of a company from Section 2. Any UUID works for `agentId`. The audit write for an unknown agent is logged and dropped, and does not fail the call.

Set the two values once:

```bash
COMPANY_ID=<company id>
AGENT_ID=$(uuidgen)
```

Make a table:

```bash
curl -s -X POST http://localhost:3015/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"create_table","arguments":{
          "companyId":"'$COMPANY_ID'","agentId":"'$AGENT_ID'",
          "name":"orders","purpose":"Customer orders",
          "schema":{"type":"object","properties":{
            "order_id":{"type":"string"},"total":{"type":"number"}},
            "required":["order_id","total"]},
          "primary_key":["order_id"]}}}'
```

Expected: the table, as JSON, with the name `orders`.

Insert a record, and then the same call again:

```bash
curl -s -X POST http://localhost:3015/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
        "name":"insert","arguments":{
          "companyId":"'$COMPANY_ID'","agentId":"'$AGENT_ID'","table":"orders",
          "record":{"order_id":"A1","total":10.10}}}}'
```

Expected the first time: `"status":"inserted"`. Expected the second time: `"status":"already_exists"` with `"matches":true`, and no second record.

Add a second order (`"order_id":"A2","total":20.20`), then total them:

```bash
curl -s -X POST http://localhost:3015/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
        "name":"aggregate","arguments":{
          "companyId":"'$COMPANY_ID'","agentId":"'$AGENT_ID'","table":"orders",
          "op":"sum","field":"total"}}}'
```

Expected: one row whose `value` is the string `"30.30"`.

Try a record that does not fit, such as `{"order_id":"A3"}` with no `total`. Expected: an error result (`isError: true`) that names the missing field. The call itself does not fail.

---

## Testing complete

You have verified the full stack end to end:

| Section                                                          | ✓   |
| ---------------------------------------------------------------- | --- |
| Infrastructure — all services healthy                            |     |
| Companies & roles — create and retrieve                          |     |
| Chat agents — multi-turn conversation                            |     |
| Autonomous agents — job dispatch and completion                  |     |
| RAG & documents — upload, retrieve, and verify in agent response |     |
| MCP servers — tool listing, describe, read, write                |     |

[← Back to start](./start.md)
