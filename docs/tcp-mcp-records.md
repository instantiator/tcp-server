# tcp-mcp-records

**Status:** Implemented
**Port:** 3015
**Transport:** MCP Streamable HTTP — stateless, one session per request

`tcp-mcp-records` is a NestJS MCP server that lets agents keep structured records: orders, customers, expenses and the like. Each company has its own tables. An agent makes a table when none fits, adds and changes records, and asks for lists and exact totals. It lives in `apps/backend/apps/tcp-mcp-records/` and runs as a Docker Compose service.

The server has its own database connection (see [Configuration](#configuration)). It does not call tcp-server for data. It does call tcp-server to write audit events, and tcp-server calls it once when a company is deleted.

The code that does the work is `RecordsService` in `libs/tcp-shared/src/records/`. The MCP server is a thin layer on top. It is shared, so tcp-server uses the same service for people's access (see [People's access](#peoples-access-00103)).

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

A key's stored name is its field names joined (`order_id`, or `marketplace,listing_id`), and its stored value holds only the values. Renaming a key field therefore changes only `keyName`; changing the key rebuilds that key's rows.

### Column changes and locking (001.06)

A column change rewrites records, so it must never meet a write that read the old columns. Every write reads the table's definition inside its own transaction, under `FOR SHARE` on the `record_table` row. A column change takes `FOR UPDATE` on that row first. Writes don't block each other, but a column change waits for writes in flight, and new writes wait for it. The table lock is always taken before any record lock, so the two can't deadlock. Deleting rows by id and clearing a table never read the columns, so they take no table lock.

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
| [`alter_table`](#alter_table)         | `alter_table(table, action, …)`                                  | Add or rename a column, or widen the key         |
| [`do_not_store`](#do_not_store)       | `do_not_store(action, value, reason)`                            | Add someone to the do-not-store list             |

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

## `do_not_store`

Adds an entry to the company's do-not-store list (001.04): a name, email address or other text that records may not contain. `action` is `add`, `remove` or `change`.

- **`add`** stores the entry, with `reason` as its note. An entry already on the list (in any case or spacing) is answered as done.
- **`remove` and `change` do nothing.** Taking someone off the list is a person's decision, so the tool answers with advice: ask a user with `request_user_input`, naming the entry and why.

It is offered in every mode, read-only ones too: a customer may ask in a chat, and adding to the list only protects people. Agents can't read the list; they learn of an entry only when a write is refused.

### Refused writes

`insert` and `update` check the record (for `update`, the changed fields) against the list first. A text field matches when it contains an entry as a whole word or phrase, ignoring case, spacing and accents: "Ann Lee" matches "Deliver to ann lee, 3 High St" but "Ann" doesn't match "Annual". Fields that aren't text are not checked.

A match stores nothing and answers `{ status: "not_stored", fields, note }`. The note tells the agent not to try another spelling, and to call `fail_assignment` with reason `data_protection` if the task can't be done without the data. The refusal is audited as a read naming the fields, never their values.

The check runs just before the write, outside its transaction, so an entry added in that instant can miss one write.

---

## `alter_table`

Changes a table's columns or primary key (001.06), so an agent can fix a table instead of making another. One tool, not four, because every tool's schema is sent on every turn. It costs about 500 tokens a turn.

| Parameter     | For                          | Description                                                                                                             |
| ------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `table`       | all                          | The table name                                                                                                          |
| `action`      | all                          | `add_column`, `rename_column`, `retype_column`, `set_primary_key`, `delete_column`, `add_unique_key`, `drop_unique_key` |
| `column`      | add, rename, retype, delete  | The column                                                                                                              |
| `type`        | add, retype                  | `string`, `number`, `integer` or `boolean`                                                                              |
| `format`      | add, retype                  | `date`, for a text column holding `YYYY-MM-DD`                                                                          |
| `description` | add                          | Shown as the column's tooltip                                                                                           |
| `default`     | add                          | Given to every existing record. Without it, they are left blank                                                         |
| `required`    | add                          | Allowed only with a `default`, or on an empty table                                                                     |
| `new_name`    | rename                       | The new name                                                                                                            |
| `fields`      | set_primary_key, unique keys | The key's fields                                                                                                        |

- **Add** checks the name, the 50-column limit, that the default fits the column, that it keeps every record under 64 KB, and that it is not on the do-not-store list.
- **Rename** moves the field in every record, the schema, `required`, the keys, `retention.from` and the stored key names. Key fields can be renamed.
- **Set key** needs every field to be a string or integer column with a value in every record. It refuses with a count and example record ids when values are missing, and with up to three example values when two records would share a key. The new fields become required. **An agent may only add fields to the key**: a narrower key can make different records count as the same one, so the refusal tells it to ask a user.
- **Retype** converts every value: numbers written as text become numbers, any value can become text, and text already written as a `YYYY-MM-DD` date or as `true`/`false` keeps its meaning. Only records whose value changes are rewritten, and any key the column is in is rebuilt, so `"01"` and `"1"` both becoming `1` is refused as a clash. A key column must stay text or a whole number, and the column retention counts from can't be retyped. **If any value won't convert, an agent is refused** with the count, up to three examples, and advice to ask a user.
- **Unique keys** are a person's choice: `add_unique_key` and `drop_unique_key` change nothing and advise asking a user, naming the fields.
- **Delete** deletes nothing. It answers with advice to ask a user with `request_user_input`, naming the column. A key column, or the column retention counts from, is refused outright with the reason.

Each rewritten record's `version` goes up, so an edit made against the old columns is refused as stale. Its `updatedAt` does not change: a column change is not an edit of its data, and retention must not restart. People can also do what agents are advised to ask for (see [Routes](#routes)): narrow the key, add and drop unique keys, delete columns, and retype a column whose values don't all convert, which blanks those values once confirmed. A key or required column is never blanked.

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
- **Plan and QA are read-only.** In `plan` and `qa` mode the agent side drops `create_table`, `insert`, `update`, `alter_table` and `delete` (`RECORDS_WRITE_TOOLS` in `mode-tools.ts`). The records server does no mode check of its own. If an agent were seen changing records in those modes, a server-side check would be needed. See [outstanding-issues.md](outstanding-issues.md#plan-and-qa-are-read-only-for-records-on-the-agent-side-only).
- **The internal route** (`DELETE /internal/companies/:id/records`) needs the internal API key, like tcp-server's `/internal/*` routes.

---

## Audit

The server writes audit events itself, through `AuditClientService`, because it knows what changed. tcp-server fills in the task and assignment from the `agentId`. The role column is `agent`. See [ADR-008](ADRs/ADR-008-audit-logging.md#amendment-as-implemented-p04-001-01).

Changes are `state_change` events. Reads are `tool_call` events. Both carry `source: 'records'`.

| Event          | Payload                                                             | When                                                              |
| -------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `state_change` | `{ action: 'create_table', table, definition }`                     | A table is made                                                   |
| `state_change` | `{ action: 'insert', table, recordId, before: null, after }`        | A record is added                                                 |
| `state_change` | `{ action: 'update', table, recordId, before, after }`              | A record is changed                                               |
| `state_change` | `{ action: 'delete', table, recordId, before, after: null }`        | A record is deleted                                               |
| `tool_call`    | `{ tool: 'query', table, filters, recordIds }`                      | A query                                                           |
| `tool_call`    | `{ tool: 'aggregate', table, op, field, groupBy, filters, groups }` | An aggregate                                                      |
| `tool_call`    | `{ tool: 'insert', table, outcome: 'already_exists', recordIds }`   | An insert that found an existing record                           |
| `state_change` | `{ action: 'alter_table', op, table, before, after, rewritten }`    | A column change. Definitions and a count, never the default value |

Audit writes are fire-and-forget. A lost audit request does not undo the write. tcp-agent also records its own `tool_call` and `tool_result` events for every tool call.

### Changes made by people

When a person changes records in the web UI, tcp-server writes the audit event itself (`RecordsApiService`). It is a `state_change` with role `user` and no agent, and the payload carries `source: 'records'` and the person's `userId`. Reads are not audited, as with the storage proxy. See [ADR-008](ADRs/ADR-008-audit-logging.md#amendment-as-implemented-p04-001-03).

| Event          | Payload                                                                           | When                                 |
| -------------- | --------------------------------------------------------------------------------- | ------------------------------------ |
| `state_change` | `{ action: 'create_table', table, definition, userId }`                           | A table is made through the API      |
| `state_change` | `{ action: 'add_row', table, recordId, after, userId }`                           | A row is added                       |
| `state_change` | `{ action: 'update', table, recordId, before, after, userId }`                    | A row is edited                      |
| `state_change` | `{ action: 'delete_row', table, recordId, before, userId }`                       | A row is deleted                     |
| `state_change` | `{ action: 'append_csv', table, inserted, alreadyExists, userId }`                | A CSV is appended                    |
| `state_change` | `{ action: 'clear_table', table, removed, userId }`                               | A table is cleared. A count, no rows |
| `state_change` | `{ action: 'drop_table', table, definition, removed, userId }`                    | A table is deleted. Keeps the schema |
| `state_change` | `{ action: 'alter_table', op, table, before, after, rewritten, blanked, userId }` | A column change. No default value    |

Clear and drop record how many rows went, not the rows. Drop keeps the table's definition so it can be made again.

---

## People's access (001.03)

People can read and correct records in the web UI, and download and append CSV. tcp-server does this itself. It does not call the records server. See [web-client.md](web-client.md#record-tables) for the screens and [tcp-cli.md](tcp-cli.md#list-tables) for the CLI verbs.

### The `records` connection

tcp-server opens a second TypeORM connection, named `records`, in `apps/backend/apps/tcp-server/src/records/records.module.ts`.

- It connects to `RECORDS_DATABASE_URL`, or `DATABASE_URL` when that is empty.
- It has a pool of 5 and no entities and no migrations. `tcp-mcp-records` still owns the tables and the migrations.
- It builds a `RecordsService` on that connection, the same class the agents use.
- Without Postgres (unit tests), it falls back to an in-memory SQLite database, so any records call fails there.

Every `RecordsService` method takes `companyId` first, and every route checks that the caller is a member of that company.

### Routes

All routes are under `/api/company/:companyId/records`. All need a signed-in company member. There are no role checks, so any member can edit, clear and delete.

| Method and path                          | Does                                                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GET tables`                             | The company's tables: `name`, `purpose`, `records`, `updatedAt`                                                                    |
| `POST tables`                            | Makes a table from the same JSON Schema an agent sends to `create_table`. See below                                                |
| `GET tables/:table`                      | The definition and the rows (newest change first, at most 10,000), with `total` and `truncated`                                    |
| `DELETE tables/:table`                   | Deletes the table and every row. Returns `{ removed }`                                                                             |
| `GET tables/:table/csv`                  | One table as `text/csv`                                                                                                            |
| `POST tables/:table/csv`                 | Appends rows from an uploaded CSV (multipart field `file`). All or nothing                                                         |
| `POST tables/:table/rows`                | Adds a row. 409 `conflict` if its key is already held                                                                              |
| `PATCH tables/:table/rows/:id`           | Edits a row: `{ changes, version }`. 409 `stale` if the row changed since `version`                                                |
| `DELETE tables/:table/rows/:id`          | Deletes a row (`?version=` is checked the same way). 204                                                                           |
| `DELETE tables/:table/rows`              | Clears the table: every row goes, the table stays. Returns `{ removed }`                                                           |
| `GET export`                             | Every table as a zip of CSVs (`application/zip`)                                                                                   |
| `POST tables/:table/columns`             | Adds a column (`?confirmDoNotStore` for a default on the list). Returns the definition (001.06)                                    |
| `PATCH tables/:table/columns/:column`    | Renames a column: `{ newName }`                                                                                                    |
| `DELETE tables/:table/columns/:column`   | Deletes a column and its values. 400 for a key column                                                                              |
| `POST tables/:table/unique-keys`         | Adds a unique key: `{ fields }`. Refused if records would clash or lack a value                                                    |
| `DELETE tables/:table/unique-keys/:key`  | Drops the unique key whose fields, joined by commas, are `:key`                                                                    |
| `PUT tables/:table/columns/:column/type` | Retypes a column: `{ type, format? }`. 409 `unconvertible` names values that won't convert; `?blankUnconvertible=true` blanks them |
| `PUT tables/:table/primary-key`          | Replaces the key: `{ fields }`. People may narrow it; refused if records would clash                                               |

`POST tables` has no screen. It exists for tests, tools and, later, templates (002.03).

### Version checks and key clashes

Every row has a `version`. An edit or a delete sends the version it saw. If the row has changed since, the server answers 409 with `code: 'stale'` and changes nothing. A row added with a primary or unique key that another row holds gets 409 with `code: 'conflict'` (and the `recordId` that holds it). The 409 does not carry the current row, so the web client reloads the table. A schema failure is a 400 that lists the messages.

### CSV

- **Columns** are the table's fields in `fieldOrder` (`libs/tcp-shared/src/records/field-order.ts`): the primary key first, then the rest alphabetically. Postgres `jsonb` loses the order an agent declared its fields in, so this is our own stable order. There is no `id` or timestamp column, so an exported file can be appended back.
- **Encoding** is UTF-8 with a byte order mark, so Excel opens it correctly. Uploads may carry one too.
- **Formula guard.** Agents write records from untrusted content, and Excel runs a cell that starts with `=`, `+`, `-` or `@`, a tab or a carriage return as a formula. On export, a text cell that starts that way gets a leading `'`. On append, one leading `'` before those characters is removed, so a file still round-trips.
- **Append is all or nothing.** The first line names the columns. An unknown column is an error; a missing optional column is fine; an empty cell means the field is absent. If any row fails, nothing is added. Errors are listed by spreadsheet row, with the header as row 1.
- **Limits** are 5 MB and 10,000 rows per upload.
- **Rows whose key is already held** are skipped and counted, not treated as errors. The result is `{ inserted, alreadyExists }`.
- **File order.** All rows in one append share a transaction, and `now()` is the transaction's start time. So each appended row is stamped with `now()` plus its position in the file in microseconds (`createdAt` and `updatedAt`), and an export keeps the file's order whatever the clock does.
- **File names** are `YYYY-MM-DD HH-mm-ss {company-slug} {table}.csv` and `… {company-slug} tables.zip`, in the time of whoever makes the file.

The export is built in memory (see [outstanding-issues.md](outstanding-issues.md#record-exports-are-built-in-memory)).

### New `RecordsService` methods

| Method                    | Does                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `listTableSummaries`      | Tables with record counts and the latest change                                              |
| `readRows`                | A table's definition and rows with timestamps, newest first, up to a cap. Sets `truncated`   |
| `readRow`                 | One row with its timestamps                                                                  |
| `forEachRowBatch`         | Walks every row in batches of 1,000, oldest first, with no cap. For exports                  |
| `insertMany`              | Adds many rows in one transaction, or none. Reports every failing row. Held keys are counted |
| `clearTable`, `dropTable` | Remove all rows, or the table too. Return how many rows went                                 |
| `update`, `delete`        | Gain an optional `expectedVersion`. A mismatch is a `conflict` error                         |

`RecordsError` now has a `code`: `not_found`, `conflict` or `invalid`. The controller maps it to 404, 409 or 400. The MCP tool outputs did not change.

## Data protection (001.04)

### Routes

All under `/api/company/:companyId/records`, members only.

| Route                                                        | Does                                                                                                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `POST search` `{q}`                                          | Rows in every table with a field containing `q`, any case, grouped by table. At most 1,000. A POST so the name stays out of URLs and logs |
| `POST export` `{tables: {[name]: ids \| "all"}}`             | One table as CSV, several as a zip of CSVs                                                                                                |
| `POST tables/:table/rows/delete` `{rows: [{id, version}]}`   | Deletes those rows, all or none. 409 `stale` if any moved on                                                                              |
| `PUT tables/:table/retention` `{retention}`                  | Sets `{days, from}` or clears it with `null`. 400 if `from` isn't `updated` or a date field                                               |
| `GET`/`POST do-not-store`, `PATCH`/`DELETE do-not-store/:id` | The list. A duplicate entry is 409                                                                                                        |

Adding a row, editing one, and appending CSV return **409 `do_not_store`** with the matching `fields` when the data matches the list. The web client asks the person, then repeats the call with `?confirmDoNotStore=true`. People are warned, not stopped.

### Retention

A table's `retention` is `{days, from}`: rows are deleted `days` after `from`, which is `updated` (the row's last change) or one of the table's date fields. A row whose date field is blank, or not a date, is kept. `RecordsRetentionService` in tcp-server sweeps every hour; a table that fails to sweep is logged and skipped.

### Audit

Bulk deletes, retention changes and sweeps, and list changes are `state_change` with `source: records`. They carry ids, counts, table and field names, never row values or list entries: the audit log isn't erased with the rows, so it mustn't keep what they held. A sweep is audited as role `system`; a person's override of the list is recorded as `doNotStoreOverride: [fields]`.

### What it doesn't reach

Search, export and delete cover record tables only, not the audit log, transcripts, knowledge, company resources, files, agents' memory or backups. The web page says so, and [outstanding-issues.md](outstanding-issues.md#data-protection-reaches-record-tables-only) tracks it.

---

## Configuration

| Variable               | Used by                     | Value                                                                                                                                                |
| ---------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_RECORDS_URL`      | tcp-server, tcp-agent       | `http://tcp-mcp-records:3015` (compose adds `/mcp` for agents)                                                                                       |
| `DATABASE_URL`         | tcp-mcp-records             | The main database. Required                                                                                                                          |
| `RECORDS_DATABASE_URL` | tcp-mcp-records, tcp-server | Optional. A separate database for records. Empty means `DATABASE_URL`. tcp-server reads it too, for the web UI's reads and edits (compose passes it) |

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

The first migration, `1784870000000-RecordTables`, makes the three tables. It adds the company foreign keys (`ON DELETE CASCADE`) only when `tcp_company` exists in the database. `1784910000000-DataProtection` adds `record_table.retention` and the `record_do_not_store` list, the same way. `deleteCompany` clears the list too, for a separate database with no foreign key.

The test tiers run the records migrations after tcp-server's in `apps/backend/test/support/migrate-database.ts`.

---

## Health

`GET /health` pings the database and returns 200 when it answers, 503 when it does not. The body names the service, like every other server's.

---

## Testing

| Tier        | Location                                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `apps/backend/apps/tcp-mcp-records/src/**/*.spec.ts` (tool wiring, audit payloads, prompts)                                                                                                                               |
| Integration | `apps/backend/test/integration/tcp-shared/records.integration-spec.ts` (concurrent inserts and updates, column changes racing writes, company isolation, injection, exact sums, a separate database migrating on its own) |
| e2e         | `apps/backend/test/e2e/tcp-mcp-records/` (health, MCP protocol, the internal delete route)                                                                                                                                |

See [manual-testing/06-mcp-servers.md](manual-testing/06-mcp-servers.md) for a manual check.

---

## What it deliberately does not do

| Not offered                                               | Why                                                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Agents clearing or dropping a table                       | Only people can, through the web UI and API (001.03). Agents have no such tool    |
| Agents deleting a column                                  | Deletes a value from every record: the tool advises asking a person (001.06)      |
| Agents narrowing a key                                    | Can make different records count as one: the tool advises asking a person         |
| Agents changing unique keys, or blanking values to retype | The tool advises asking a person, who can                                         |
| Template table schemas                                    | Orders, customers and so on are not shipped. Planned for 002.03                   |
| Nested objects or array fields                            | Fields are scalars, so queries and totals stay simple and exact                   |
| Raw SQL                                                   | Agents never write SQL. Every query is built from checked fields and bound values |
| A server-side read-only mode                              | Plan and QA are filtered on the agent side. Company scoping is the boundary       |
| Guaranteed audit                                          | Audit writes are fire-and-forget                                                  |
