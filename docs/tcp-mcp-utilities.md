# tcp-mcp-utilities

**Status:** Implemented
**Port:** 3014
**Transport:** MCP Streamable HTTP — stateless, one session per request

`tcp-mcp-utilities` is a NestJS MCP server that does exact arithmetic, date maths and unit conversion for agents. Language models get sums wrong. These tools give them a reliable answer instead. It lives in `apps/backend/apps/tcp-mcp-utilities/` and runs as a Docker Compose service.

It is stateless. It has no database and makes no calls to tcp-server. Each tool call creates a fresh MCP session, and nothing is stored. The server exposes `GET /health` (the shared `StaticHealthModule`, which has no dependencies to check) and `POST /mcp`.

It does not write audit events itself. tcp-agent already records a `tool_call` and a `tool_result` event for every tool call, and that covers these tools too.

No tool takes `companyId` or `agentId`. The tools are offered to every agent mode (see `libs/tcp-shared/src/prompts/mode-tools.ts`).

See [agent-services.md → MCP Servers](agent-services.md#mcp-servers) for how agents connect.

---

## Tools

| Tool                                  | Signature                                                                                             | Description                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| [`describe_server`](#describe_server) | `describe_server()`                                                                                   | Overview of the utilities service and its tools |
| [`calculate`](#calculate)             | `calculate(expression)`                                                                               | Exact decimal arithmetic                        |
| [`date_math`](#date_math)             | `date_math(operation, date, other_date?, years?, months?, weeks?, days?, holidays?, tax_year_start?)` | Calendar date calculations                      |
| [`convert_units`](#convert_units)     | `convert_units(value, from, to)`                                                                      | Exact weight and length conversion              |

Tool descriptions live in `apps/backend/apps/tcp-mcp-utilities/src/tools.jsonc`. The `describe_server` text lives in `prompts.jsonc` beside it.

A bad input is not a failed call. The tool returns an error result that says what is wrong, so the agent can fix it and try again.

---

## `describe_server`

Returns a markdown overview of the utilities service and its tools.

**Arguments:** none

**Usage pattern:** orientation only. It is not a precondition for anything. It also tells the agent that there is no currency conversion, and that a currency sum should use `calculate` with a rate the agent states.

---

## `calculate`

Works out an arithmetic expression exactly, using [decimal.js](https://github.com/MikeMcl/decimal.js). The expression is parsed by a small recursive-descent parser. It is never passed to `eval`.

**Arguments:**

| Parameter    | Type   | Required | Description                                     |
| ------------ | ------ | -------- | ----------------------------------------------- |
| `expression` | string | yes      | The expression, e.g. `round(3 * 4.99 * 1.2, 2)` |

**Returns:** the result as plain text.

```text
calculate("round(3 * 4.99 * 1.2, 2)")  →  17.96
calculate("120 * 20%")                 →  24
```

**Grammar:**

| Element                | Notes                                                             |
| ---------------------- | ----------------------------------------------------------------- |
| `+ - * /`              | Usual precedence. Brackets group.                                 |
| `^`                    | Power. The exponent must be a whole number, at most 1000 in size. |
| `%`                    | Postfix. `20%` means `20 / 100`. It is **not** modulo.            |
| `round(x, dp)`         | Rounds half-up to `dp` decimal places (0 to 20).                  |
| `round_even(x, dp)`    | Rounds half-even ("banker's rounding") to `dp` decimal places.    |
| `floor`, `ceil`, `abs` | One argument.                                                     |
| `min`, `max`           | One or more arguments.                                            |

**Limits:**

- Working precision is 40 significant digits. Results are given to at most 20 decimal places.
- The expression may be at most 1000 characters long, and brackets may nest at most 100 deep.
- Write plain numbers. No currency symbols and no thousands separators (`1,000` is an error).
- Division by zero, and zero to a negative power, are errors.
- The tool does not round money for the agent. The agent rounds with `round(...)` where it needs to.

---

## `date_math`

Calendar arithmetic on dates. Dates are `YYYY-MM-DD` only. There are no times and no time zones. It uses the built-in `Temporal` API.

**Arguments:**

| Parameter                          | Type     | Required         | Description                                                                         |
| ---------------------------------- | -------- | ---------------- | ----------------------------------------------------------------------------------- |
| `operation`                        | enum     | yes              | `add`, `subtract`, `add_business_days`, `difference`, `tax_year`                    |
| `date`                             | string   | yes              | The starting date                                                                   |
| `other_date`                       | string   | for `difference` | The end date                                                                        |
| `years`, `months`, `weeks`, `days` | integer  | no               | Amounts to move by. For `add_business_days`, `days` is required and may be negative |
| `holidays`                         | string[] | no               | Dates that are not business days                                                    |
| `tax_year_start`                   | string   | no               | First day of the tax year, `MM-DD`. Default `04-06`                                 |

**Operations:**

| Operation           | Returns                                                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add` / `subtract`  | `{ "result": "2026-02-28", "clamped": true }`. Years and months move first. If the day does not exist in the new month, it clamps to the month end and `clamped` is `true` (31 Jan + 1 month = 28 Feb). |
| `add_business_days` | `{ "result": "2026-10-12" }`. Business days are Monday to Friday, minus `holidays`. The start date is never counted. At most 10000 days.                                                                |
| `difference`        | `{ "days": 4, "business_days": 2 }`. Counts from `date` to `other_date`. The earlier date is not counted. Negative if `other_date` is earlier. At most 100 years apart.                                 |
| `tax_year`          | `{ "start": "2026-04-06", "end": "2027-04-05", "label": "2026/27" }`. The tax year that contains `date`. A start of `01-01` gives a calendar year and a label like `2026`.                              |

Example:

```json
{ "operation": "add_business_days", "date": "2026-10-09", "days": 1 }
```

returns `{ "result": "2026-10-12" }`, because 10 and 11 October 2026 are a weekend.

---

## `convert_units`

Converts a weight or length using exact decimal factors.

**Arguments:**

| Parameter | Type   | Required | Description                         |
| --------- | ------ | -------- | ----------------------------------- |
| `value`   | string | yes      | The amount as a decimal, e.g. `2.5` |
| `from`    | string | yes      | Unit to convert from                |
| `to`      | string | yes      | Unit to convert to                  |

**Units:**

| Dimension | Units                                         |
| --------- | --------------------------------------------- |
| Mass      | `mg`, `g`, `kg`, `t`, `oz`, `lb`, `st`        |
| Length    | `mm`, `cm`, `m`, `km`, `in`, `ft`, `yd`, `mi` |

**Returns:** a line such as `2.5 lb = 1.133980925 kg`. Converting between a mass and a length is an error.

---

## What it deliberately does not do

| Not offered          | Why                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Currency conversion  | There is no source of exchange rates. An agent should use `calculate` with a rate it states. See [outstanding-issues.md](outstanding-issues.md). |
| Holiday calendars    | Business days skip weekends and any `holidays` the agent passes. The server knows no regional holidays.                                          |
| Times and time zones | Dates only.                                                                                                                                      |
| Modulo               | `%` is percent.                                                                                                                                  |

---

## Configuration

| Variable            | Used by               | Value                           |
| ------------------- | --------------------- | ------------------------------- |
| `MCP_UTILITIES_URL` | tcp-server, tcp-agent | `http://tcp-mcp-utilities:3014` |

The server reads only the shared MCP config (`PORT`, default 3014, plus the `TCP_SERVER_URL` and `INTERNAL_API_KEY` that the shared schema requires, though this server never uses them). Omit `MCP_UTILITIES_URL` to disable the server for agents. The registry name is `utilities`.

---

## Testing

| Tier | Location                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit | `apps/backend/apps/tcp-mcp-utilities/src/calc/*.spec.ts` (the calculation code) and `src/mcp/utilities-tools.service.spec.ts` (tool wiring and error results) |
| e2e  | `apps/backend/test/e2e/tcp-mcp-utilities/` (health and MCP protocol)                                                                                          |

See [manual-testing/06-mcp-servers.md](manual-testing/06-mcp-servers.md) for a manual check.
