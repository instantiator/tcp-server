# tcp-mcp-records

**Status:** Implemented
**Port:** 3015
**Transport:** MCP Streamable HTTP — stateless, one session per request

`tcp-mcp-records` is a NestJS MCP server that lets agents keep structured records: orders, customers, expenses and the like. Each company has its own tables. An agent makes a table when none fits, adds and changes records, and asks for lists and exact totals. It lives in `apps/backend/apps/tcp-mcp-records/` and runs as a Docker Compose service.

The server has its own database connection (see [Configuration](#configuration)). It does not call tcp-server for data. It does call tcp-server to write audit events, and tcp-server calls it once when a company is deleted.

The code that does the work is `RecordsService` in `libs/tcp-shared/src/records/`. The MCP server is a thin layer on top. It is shared so the web UI (001.03) can use the same service.

The tools are offered to every agent mode (see `libs/tcp-shared/src/prompts/mode-tools.ts`). See [agent-services.md → MCP Servers](agent-services.md#mcp-servers) for how agents connect.

---

## Data model

Three tables, made by one migration. No table is ever created or altered for an agent's table.

| Table          | One row per           | Holds                                                                                    |
| -------------- | --------------------- | ---------------------------------------------------------------------------------------- |
| `record_table` | agent-made table      | `companyId`, `name`, `purpose`, `schema` (JSON Schema), `primaryKey`, `uniqueKeys`       |
| `record`       | record                | `tableId`, `companyId`, `data` (JSONB), `version` (starts at 1, goes up on every update) |
| `record_key`   | key value of a record | `(tableId, keyName, keyValue)` as the primary key, and the `recordId` that holds it      |

Names are unique per company: `(companyId, name)`.

### Why `record_key` exists

A table's primary key and unique keys must never match two records, even when two agents insert at the same moment. JSONB has no per-table unique index, and the server does not run DDL for each agent table. So each key value of each record gets a row in `record_key`. Its primary key is `(tableId, keyName, keyValue)`.

An insert writes the record and its key rows in one transaction. If another insert holds the same key, Postgres refuses the second row. The loser rolls back, looks up the winner and returns it (see [Idempotency](#idempotency)). The check lives in the database, so it holds under any amount of concurrency. An update rewrites the key rows in the same transaction.

Deleting a table's record, or the table, cascades to its key rows.

---

## Tools

Every tool takes `companyId` and `agentId`. The agent side injects both (see [Access control](#access-control)), so the model never sees them.

| Tool                                  | Signature                                                        | Description                                      |
| ------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------ |
| [`describe_server`](#describe_server) | `describe_server()`                                              | Overview of the records service and its tools    |
| [`list_tables`](#list_tables)         | `list_tables()`                                                  | The company's tables, with what each is for      |
| [`describe_table`](#describe_table)   | `describe_table(table)`                                          | One table's fields, primary key and unique keys  |
| [`create_table`](#create_table)       | `create_table(name, purpose, schema, primary_key, unique_keys?)` | Make a new table                                 |
| [`insert`](#insert)                   | `insert(table, record)`                                          | Add a record. Safe to retry                      |
| [`update`](#update)                   | `update(table, id \| key, changes)`                              | Change fields of one record                      |
| [`delete`](#delete)                   | `delete(table, id \| key)`                                       | Delete one record                                |
| [`query`](#query)                     | `query(table, filters?, sort?, limit?, offset?)`                 | Find records                                     |
| [`aggregate`](#aggregate)             | `aggregate(table, op, field?, group_by?, filters?)`              | Count, sum, average, minimum or maximum, exactly |

Tool descriptions live in `apps/backend/apps/tcp-mcp-records/src/tools.jsonc`. The `describe_server` text lives in `prompts.jsonc` beside it.

A bad input is not a failed call. The tool returns an error result that says what is wrong and how to fix it, so the agent can try again. Nothing is audited for such a call, because nothing was read or changed.

---

## `describe_server`

Returns a markdown overview of the records service and its tools.

**Arguments:** none

**Usage pattern:** orientation only. It is not a precondition for anything.

---

## `list_tables`

Returns the company's tables, alphabetically, as `{ name, purpose }`. If there are none, it says so and suggests `create_table`.

**Arguments:** none (apart from the injected identity)

---

## `describe_table`

Returns one table: `id`, `name`, `purpose`, `schema`, `primaryKey` and `uniqueKeys`. An agent should call it before it inserts or queries.

| Parameter | Type   | Required | Description    |
| --------- | ------ | -------- | -------------- |
| `table`   | string | yes      | The table name |

---

## `create_table`

Makes a table.

| Parameter     | Type       | Required | Description                                                |
| ------------- | ---------- | -------- | ---------------------------------------------------------- |
| `name`        | string     | yes      | The table name                                             |
| `purpose`     | string     | yes      | What the table holds. Every agent sees it in `list_tables` |
| `schema`      | object     | yes      | A JSON Schema object for one record                        |
| `primary_key` | string[]   | yes      | The field(s) that identify a record                        |
| `unique_keys` | string[][] | no       | Other field sets that must be unique                       |

```json
{
  "name": "orders",
  "purpose": "Customer orders from the shop",
  "schema": {
    "type": "object",
    "properties": {
      "order_id": { "type": "string" },
      "customer": { "type": "string" },
      "total": { "type": "number" },
      "ordered_on": { "type": "string", "format": "date" }
    },
    "required": ["order_id", "customer", "total"]
  },
  "primary_key": ["order_id"]
}
```

**Rules and limits** (in `libs/tcp-shared/src/records/table-schema.ts`):

- Table and field names are lower case letters, digits and underscores. They start with a letter and are at most 63 characters long.
- A table has 1 to 50 fields. A company has at most 50 tables.
- Every field has a scalar `type`: `string`, `number`, `integer` or `boolean`. Use `"format": "date"` for a date as `YYYY-MM-DD`. There are no nested objects and no arrays.
- `required` may name only fields the schema declares.
- `"type": "object"` may be left out; small models often forget it, and a schema with `properties` can only mean that.
- The server closes the schema (`additionalProperties: false`) whatever the agent sends. A record with an unknown field is refused.
- The schema is checked by a strict Ajv. A misspelt keyword is an error, not silently ignored.
- Every key field must be a `required` field of type `string` or `integer`. A key may not name a field twice. Floats and booleans are not allowed, because keys must compare exactly.
- `purpose` is 1 to 1000 characters.
- A record may be at most 64 KB of JSON.
- A name that is already taken is an error that points the agent to `describe_table`.

---

## `insert`

Adds a record. The record must fit the table's schema. The result says what happened.

| Parameter | Type   | Required | Description                          |
| --------- | ------ | -------- | ------------------------------------ |
| `table`   | string | yes      | The table name                       |
| `record`  | object | yes      | The record, as field and value pairs |

```json
{
  "table": "orders",
  "record": { "order_id": "A1", "customer": "Ada", "total": 24.5 }
}
```

returns `{ "status": "inserted", "record": { "id": "…", "data": { … }, "version": 1 } }`. See [Idempotency](#idempotency) for the other result.

---

## `update`

Changes some fields of one record. Find the record by its `id`, or by `key` (its primary key values).

| Parameter | Type   | Required | Description                                         |
| --------- | ------ | -------- | --------------------------------------------------- |
| `table`   | string | yes      | The table name                                      |
| `id`      | string | one of   | The record id                                       |
| `key`     | object | one of   | The primary key values, e.g. `{ "order_id": "A1" }` |
| `changes` | object | yes      | Fields to change. A field set to `null` is removed  |

The changes merge into the record. The result is checked against the schema again, so removing a required field is an error. The row is locked (`FOR UPDATE`) while this happens, so two updates to one record apply one after the other. `version` goes up by one. An update that would give two records the same key is an error.

Returns the changed record.

---

## `delete`

Deletes one record, found by `id` or `key` as in `update`. Returns `{ "deleted": "<id>" }`. The audit event keeps the record's last values.

---

## `query`

Finds records in one table.

| Parameter | Type     | Required | Description                                                |
| --------- | -------- | -------- | ---------------------------------------------------------- |
| `table`   | string   | yes      | The table name                                             |
| `filters` | object[] | no       | `{ field, op, value }`, all of which must match            |
| `sort`    | object[] | no       | `{ field, direction }`, first field first. `asc` or `desc` |
| `limit`   | integer  | no       | Records to return. Default 50, at most 200                 |
| `offset`  | integer  | no       | Records to skip. At most 10000                             |

```json
{
  "table": "orders",
  "filters": [{ "field": "ordered_on", "op": "gte", "value": "2026-10-01" }],
  "sort": [{ "field": "total", "direction": "desc" }],
  "limit": 10
}
```

Returns `{ "records": [ { id, data, version } ], "total": 37 }`. `total` counts every match, not only this page.

**Filter operators:**

| Operator                 | Meaning                                                                           |
| ------------------------ | --------------------------------------------------------------------------------- |
| `eq`                     | Equal                                                                             |
| `ne`                     | Not equal. A record without the field counts as not equal                         |
| `lt`, `lte`, `gt`, `gte` | Compare. Number fields compare as numbers (10 is more than 9). Not for booleans   |
| `contains`               | Text field only. Case-insensitive substring. `%` and `_` in the value are literal |
| `in`                     | The value is a list of 1 to 100 values                                            |

Rules:

- A field that is not in the schema is an error that lists the real fields.
- Without `sort`, or after the sort fields, the newest record comes first.
- Records that lack a sort field come last.
- Every field name and value reaches the database as a bound parameter. Nothing an agent sends is joined into the SQL text.

---

## `aggregate`

Works out one figure over matching records, optionally grouped.

| Parameter  | Type     | Required       | Description                         |
| ---------- | -------- | -------------- | ----------------------------------- |
| `table`    | string   | yes            | The table name                      |
| `op`       | enum     | yes            | `count`, `sum`, `avg`, `min`, `max` |
| `field`    | string   | except `count` | The field to work on                |
| `group_by` | string[] | no             | At most 3 fields to group by        |
| `filters`  | object[] | no             | The same filters as `query`         |

```text
aggregate(table: "orders", op: "sum", field: "total", group_by: ["customer"])
  →  [ { "group": { "customer": "Ada" }, "value": "49.00" }, … ]
```

Returns a list of `{ group, value }`. Without `group_by`, there is one row and `group` is empty.

- `sum` and `avg` need a number or integer field. `min` and `max` also take a string field (dates are strings).
- The sum is worked out in Postgres `numeric`, and `value` is a decimal **string**. A month's takings add up exactly, with no floating-point drift.
- Groups come back in order of the group values. At most 200 groups are returned.
- `count` with no `field` counts records. With a `field` it counts the records that have that field.

---

## Idempotency

An agent that retries, or restarts after a crash, must not add a record twice. So `insert` never makes a duplicate. If a record already holds the same primary or unique key, nothing is added. The result says so:

```json
{
  "status": "already_exists",
  "record": { "id": "…", "data": { … }, "version": 3 },
  "key": { "order_id": "A1" },
  "matches": true,
  "note": "…"
}
```

`matches` is `true` when the existing record holds exactly the data that was offered. The agent can treat that as success. If it is `false`, a different record has that key, and the agent should decide whether to `update` it.

This holds when two inserts race. See [Why `record_key` exists](#why-record_key-exists).

This covers records only. An action that leaves the system, such as sending an email, has no such protection yet. See [outstanding-issues.md](outstanding-issues.md#idempotency-keys-on-outbound-actions-are-not-built).

---

## Access control

- **Per company.** Every statement filters on `companyId`. An agent reaches any table of its own company and nothing of another company's. This is the security boundary.
- **Identity is injected.** `companyId` and `agentId` are in every tool's schema, but the agent side removes them from what the model sees and fills in the real values on every call (see [agent-services.md → Identity fields](agent-services.md#enabling-mcp-tools-for-a-role)). A model cannot name another company.
- **Plan and QA are read-only.** In `plan` and `qa` mode the agent side drops `create_table`, `insert`, `update` and `delete` (`RECORDS_WRITE_TOOLS` in `mode-tools.ts`). The records server does no mode check of its own. If an agent were seen changing records in those modes, a server-side check would be needed. See [outstanding-issues.md](outstanding-issues.md#plan-and-qa-are-read-only-for-records-on-the-agent-side-only).
- **The internal route** (`DELETE /internal/companies/:id/records`) needs the internal API key, like tcp-server's `/internal/*` routes.

---

## Audit

The server writes audit events itself, through `AuditClientService`, because it knows what changed. tcp-server fills in the task and assignment from the `agentId`. The role column is `agent`. See [ADR-008](ADRs/ADR-008-audit-logging.md#amendment-as-implemented-p04-001-01).

Changes are `state_change` events. Reads are `tool_call` events. Both carry `source: 'records'`.

| Event          | Payload                                                             | When                                    |
| -------------- | ------------------------------------------------------------------- | --------------------------------------- |
| `state_change` | `{ action: 'create_table', table, definition }`                     | A table is made                         |
| `state_change` | `{ action: 'insert', table, recordId, before: null, after }`        | A record is added                       |
| `state_change` | `{ action: 'update', table, recordId, before, after }`              | A record is changed                     |
| `state_change` | `{ action: 'delete', table, recordId, before, after: null }`        | A record is deleted                     |
| `tool_call`    | `{ tool: 'query', table, filters, recordIds }`                      | A query                                 |
| `tool_call`    | `{ tool: 'aggregate', table, op, field, groupBy, filters, groups }` | An aggregate                            |
| `tool_call`    | `{ tool: 'insert', table, outcome: 'already_exists', recordIds }`   | An insert that found an existing record |

Audit writes are fire-and-forget. A lost audit request does not undo the write. tcp-agent also records its own `tool_call` and `tool_result` events for every tool call.

---

## Configuration

| Variable               | Used by               | Value                                                                 |
| ---------------------- | --------------------- | --------------------------------------------------------------------- |
| `MCP_RECORDS_URL`      | tcp-server, tcp-agent | `http://tcp-mcp-records:3015` (compose adds `/mcp` for agents)        |
| `DATABASE_URL`         | tcp-mcp-records       | The main database. Required                                           |
| `RECORDS_DATABASE_URL` | tcp-mcp-records       | Optional. A separate database for records. Empty means `DATABASE_URL` |

The server reads the shared MCP config (`PORT`, default 3015, `TCP_SERVER_URL` and `INTERNAL_API_KEY`) plus the two database variables. Omit `MCP_RECORDS_URL` to disable the server for agents. The registry name is `records`.

Compose starts the records server after tcp-server is healthy. In a shared database that means `tcp_company` already exists when the records migration runs.

### A separate database

Setting `RECORDS_DATABASE_URL` keeps records in a database of their own. Use it when records should be backed up, sized or secured apart from the rest. It gives up three things:

- **No cascade on company delete.** The foreign keys to `tcp_company` are not there. Instead, after tcp-server deletes a company, `RecordsCleanupService` (`apps/backend/apps/tcp-server/src/api/records-cleanup.service.ts`) calls `DELETE /internal/companies/:id/records` on the records server. The call is best effort. A failure is logged and does not fail the delete. In a shared database the cascade has already removed the records, and the call deletes nothing.
- **Not in `scripts/backup.sh`.** The script dumps tcp-server's database only. A separate records database must be backed up another way. See [backup-and-restore.md](backup-and-restore.md).
- **Restore does not check records migrations.** The migration-version check in `restore.sh` reads only tcp-server's migrations.

A template import that replaces a company by slug leaves the old company's records behind in a separate database. They cannot be reached again, because company ids are never reused. They still take up space.

---

## Migrations

The records server has its own migration list, `apps/backend/apps/tcp-mcp-records/src/migrations-list.ts` (`RECORDS_MIGRATIONS`). Like tcp-server's, it is registered by hand, because a glob does not survive the webpack bundle. The server runs them on start (`migrationsRun: true`) and records them in the `records_migrations` table, so they never mix with tcp-server's `typeorm_migrations`. See [db-migrations.md](db-migrations.md#the-records-servers-migrations).

The one migration, `1784870000000-RecordTables`, makes the three tables. It adds the company foreign keys (`ON DELETE CASCADE`) only when `tcp_company` exists in the database.

The test tiers run the records migrations after tcp-server's in `apps/backend/test/support/migrate-database.ts`.

---

## Health

`GET /health` pings the database and returns 200 when it answers, 503 when it does not. The body names the service, like every other server's.

---

## Testing

| Tier        | Location                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `apps/backend/apps/tcp-mcp-records/src/**/*.spec.ts` (tool wiring, audit payloads, prompts)                                                                                                 |
| Integration | `apps/backend/test/integration/tcp-shared/records.integration-spec.ts` (concurrent inserts and updates, company isolation, injection, exact sums, a separate database migrating on its own) |
| e2e         | `apps/backend/test/e2e/tcp-mcp-records/` (health, MCP protocol, the internal delete route)                                                                                                  |

See [manual-testing/06-mcp-servers.md](manual-testing/06-mcp-servers.md) for a manual check.

---

## What it deliberately does not do

| Not offered                    | Why                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------- |
| Alter or drop a table          | Not needed yet. Planned for 001.03 (web UI editing) and 002.03 (templates)        |
| Template table schemas         | Orders, customers and so on are not shipped. Planned for 002.03                   |
| Nested objects or array fields | Fields are scalars, so queries and totals stay simple and exact                   |
| Raw SQL                        | Agents never write SQL. Every query is built from checked fields and bound values |
| A server-side read-only mode   | Plan and QA are filtered on the agent side. Company scoping is the boundary       |
| Guaranteed audit               | Audit writes are fire-and-forget                                                  |
