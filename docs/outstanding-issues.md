# Outstanding issues

Known defects and deferred work, each with the condition that should trigger
acting on it. Not a backlog of features — this is for things already found and
knowingly left, so they stay visible instead of being rediscovered.

Resolve an entry by deleting it, in the change that resolves it.

## Recurring backups

`scripts/backup.sh` only runs when someone runs it. Nothing takes backups on a
schedule, so the newest backup is only as recent as the last manual run.

**Act when:** 004.01 (recurring tasks) lands. Schedule `backup.sh` through it,
or, if that only schedules agent work, through the host's cron. Prune old
archives too.

## Backup archives are not encrypted

A backup archive holds every company's records and the LLM API keys saved in
company and role settings, in plain form. Mode 600 is the only protection. See
[backup-and-restore.md](backup-and-restore.md).

**Act when:** an archive is first stored off the host (cloud storage, another
machine, removable media). Encrypt before it leaves, for example with `age`
or `openssl enc`, and keep the key apart from the archives.

## Restore across a Postgres major version is untested

The dumps are tested only against the `pgvector/pgvector:pg16` image they were
taken from.

**Act when:** the `pgvector/pgvector` tag in `docker-compose.yml` changes major
version. Before merging that change, restore a backup taken on the old version
with `run-backup-tests.sh` or by hand.

## Integration tier hangs on exit

Rarely (about one run in six on 2026-10-03), the integration tier hangs after
every test has passed: `Jest did not exit one second after the test run has
completed`, then nothing. The cause is unknown. The earlier one, a native
thread from `pdf-parse`, was fixed on 2026-08-06 by loading it lazily, and no
integration spec loads it now. `--detectOpenHandles` didn't reproduce it in
three runs, probably because it changes the timing.

`run-integration-tests.sh` now catches it: after `INTEGRATION_HANG_SECONDS` it
writes a Node diagnostic report of the handles still open to
`test-results/integration-diagnostics/` and stops Jest. In CI that report is the
`integration-hang-diagnostics` artifact.

**Act when:** a diagnostic report from a real hang exists. Its `libuv` section
names the open handle; fix the code that leaves it open. Don't add
`--forceExit`, which would hide real leaks.

## Office view browser tests fail intermittently

On 2026-10-03, `company-visualisation.spec.ts` failed in 4 runs: once in the
full `run-all-tests.sh` (2 of 54 browser tests), then 3 times when run alone
against a newly rebuilt stack (2, 1 and 5 of 13). The failing runs took
1.3–1.5 minutes. The same stack then passed 3 runs out of 3 about 15 minutes
later, in about 30 seconds each.

Every failure was the same: `officeSummary(page)` (the `group` named for the
office view) was not found within the 5 second `expect` timeout. The element
was missing, not wrong. Which tests failed changed from run to run, so it's not
one test's logic.

It didn't reproduce afterwards, in 7 runs: the spec 3 times straight after
`start-deployment.sh --rebuild`, the full browser tier twice, and the full tier
twice with every CPU core busy (as slow as the failing runs). So it isn't a
cold stack, the other specs running alongside, or CPU load alone. The cause is
unknown. The traces that would show what the page displayed instead were
overwritten by the next run: Playwright clears its output folder every time.

On 2026-10-04 it failed again in `check.sh --comprehensive` (3 of 54), with a
different symptom: the office element _was_ found, but its description said
`Roles: 0. Task rooms: 0` where the test expected 2 and 1, and the call log
shows the page coming back from a sign-in redirect just before. Traces and the
full run log are in `.tmp/browser-failures/20261004-181111/` (local and
gitignored, so `git clean -X` deletes them). Three earlier failed runs from the
same day are beside it.

**Act when:** the browser tier fails this way again. `run-browser-tests.sh`
now keeps each failed run's traces in `.tmp/browser-failures/<timestamp>/`.
Open the failing test's trace with `npx playwright show-trace`. It will show whether the page was
loading, showing an error or redirecting to sign-in. Don't add retries;
`playwright.config.ts` explains why.

**Likely cause, with a fix in place (2026-10-04):** the identity provider
gets overloaded. Every signed-in page starts signed out and does a full sign-in
redirect. With 4 workers on an 8-core machine also running the whole stack,
single sign-ins took up to 16 s, and the 5 s assertion straight after `goto`
lost the race. Two changes:

- The signed-in specs open pages with `gotoSignedIn`
  (`test/browser/signed-in.ts`). It waits up to 15 s for sign-in, apart from
  the test's own assertions, and logs each sign-in as `[sign-in] <path> <ms>`.
- Those specs run in their own Playwright project, `chromium-signed-in`, at
  half the usual workers (`25%` of cores).

Measured on the same machine and stack: before, 4 failures per full run, with
sign-in p90 4–6 s and a maximum of 16 s; after, two full runs of 54/54 in
about 50 s, with sign-in p90 0.8 s and a maximum of 1.3 s.

**Act when (replaces the one above):** the browser tier fails this way again. Check the `[sign-in]`
times first. Delete this entry if no failure is seen by the end of phase 04.

## Finalisation assignment status

When the finalisation assignment of a task completes, the task moves to state `succeeded` but the finalisation task remains `in-progress`.

## `start-dev.sh` tcp-cli guidance

The `start-dev.sh` script prints some guidance at the end, including:

```text
Get a token (opens a browser for login):
  npx tcp-cli get-token
```

This doesn't work - as `tcp-cli` isn't in the registry.npmjs.org registry.

It's easier just to use `tcp-cli.sh` in the guidance for now and, in fact, probably even better to give guidance like this:

```text
Put a token into TCP_TOKEN to use it in subsequent calls. (This will open a browser for login.)
  export TCP_TOKEN=$(./tcp-cli.sh get-token)
```

It would also be nice to print this advice right at the end, but only if there are 0 companies already configured:

```text
See `your-first-company.md` to get started.
```

## `tcp-cli` options

Providing the `-i` or `--input` option for the `set-company` verb fails:

```bash
./tcp-cli.sh set-company -i ./scripts/test-data/companies/home-maintenance.json
```

The workaround is to pipe the data in with:

```bash
cat ./scripts/test-data/companies/home-maintenance.json | ./tcp-cli.sh set-company
```

It'd be good to inspect and fix all the input options, as this isn't the only case where an expected option isn't recognised.

Another I've noticed is that the `-s` option for the `store-knowledge` verb fails, but the `--source` option succeeds.

```bash
./tcp-cli.sh store-knowledge -r diy-assistant -c home-maintenance -s ./scripts/test-data/knowledge/diy-manual.pdf
```

As a part of the repair, please also unify: `-i`, `--input`, `-s`, `--source` to: `-i`, `--input-path`

## CI: the `api-test` bake spends its time exporting, not building

The `api-test` job dominates CI wall clock. Its `Build service images` step took
6m05s of a 10m06s job, but the compilation is not the cost — the export is.
From the step log of run `31016372220`:

| Layer                                            | Time |
| ------------------------------------------------ | ---- |
| `RUN npm run build:apps` (shared across targets) | 111s |
| `exporting to docker image format` × 6 images    | 772s |
| `exporting to GitHub Actions Cache`              | 114s |

`*.output=type=docker` serialises each image to a tarball and loads it into the
daemon, which is why six images cost 772s of work between them. Two ways out,
neither yet tried:

- Enable the **containerd image store** on the runner, so `type=docker` writes
  straight to the store instead of round-tripping through a tarball. Smallest
  change, but depends on runner daemon configuration.
- Push to a **local `registry:2` container** and have compose pull from it.
  Avoids the tarball entirely; more moving parts.

Two cheaper wins from the same analysis were already taken (see `.github/workflows/ci.yml`):
`npm ci` and the Playwright browser install now run underneath the bake instead
of after it, and `--with-deps` was dropped from the Chromium install — the
browser cache was hitting and the ~1m20s was entirely apt.

## CI: `mode=max` cache export is paying for a cache that cannot hit

The same bake sets `*.cache-to=type=gha,scope=monorepo-build,mode=max`, which
writes **every** intermediate layer to the Actions cache — 114s per run. The log
shows the cache manifest importing but essentially nothing hitting (`#1 CACHED`
alone), because `npm run build:apps` is invalidated by any source change, which
is every push on an active branch.

So the run pays full export cost for a cache that cannot hit on the layer that
matters. Worth measuring `mode=min` against the current setting, and worth
checking whether the branch scoping of the Actions cache means a PR ever reads
what its base branch wrote in the first place.

## Remote LLM providers are untested against a real key

The provider catalogue (`libs/tcp-shared/src/llm/provider-catalogue.ts`, 004.01) offers OpenAI, Anthropic, Google, Azure, Bedrock, Mistral and OpenRouter through their OpenAI-compatible APIs. Their base URLs and starter models were checked against each provider's documentation on 2026-09-30, but only LM Studio has ever run TCP's agents. Tool calling and structured output through a compatibility layer (Anthropic's especially) may not behave like the native API.

**Act when:** someone first uses a real key for one of these providers — run `./scripts/setup-wizard.sh --test-config`, then a chat and a task with tools, and correct that catalogue entry. Before any release, do this for at least OpenAI and Anthropic.

## Company spend caps (and % shares)

Only application-wide, per-provider spend caps exist (`SPEND_CAPS`, 000.02).
A company cap, or a company cap expressed as a percentage of an application
cap, was in the original request and was dropped in planning — a home
install usually runs one company, so splitting a shared provider's budget
across several doesn't matter yet.

**Act when:** one install runs several companies on a shared paid provider
and needs to split its budget between them.

## Spend in currency rather than tokens

Spend is reported and capped in tokens, never money. A per-model price table
(and its upkeep as providers change prices) was out of scope for 000.02.

**Act when:** a user asks for spend reported in currency, not tokens.

## Embedding and model-check usage isn't counted

`token_usage` only records LLM chat/agent calls. Embeddings (LangChain's
`OpenAIEmbeddings` exposes no usage figure to read) and the model-compatibility
probe (`POST /api/model/check`) are never recorded or capped.

**Act when:** LangChain's embeddings client starts exposing usage, or
embeddings move to a paid provider whose spend needs tracking.

## OTLP export of usage

Recorded token usage field names (`inputTokens`, `outputTokens`, `provider`,
`model`) already follow OpenTelemetry's GenAI semantic conventions, but no
OTLP exporter exists — 000.02 deliberately took no OpenTelemetry dependency.

**Act when:** an operator wants usage visible in an external dashboard.

## Cap windows are UTC only

`SPEND_CAPS`'s `month`/`week`/`day` windows all reset on UTC boundaries; there
is no per-operator or per-cap timezone setting.

**Act when:** a user asks for a cap to reset on local-time boundaries instead.

## `token_usage` rollup

Every cap check and usage report sums raw `token_usage` rows with a SQL
`SUM` over the relevant window — there is no rollup table. This is fine to
roughly a million rows.

**Act when:** the table passes about 1 million rows, or `GET /api/spend` /
`GET /api/company/:id/spend` becomes noticeably slow.

## Shared cap for `openai-compatible` endpoints

`SPEND_CAPS` is keyed by catalogue provider id. Every `openai-compatible`
endpoint shares that one id, so two different `openai-compatible` servers
share one cap and can't be capped separately.

**Act when:** two `openai-compatible` endpoints need separate caps.

## Single tcp-server instance assumption in `SpendCapService`

Cap evaluation is serialised per provider by an in-process promise chain
(`SpendCapService.chains`), which only works correctly with one tcp-server
instance. A second instance could race on the same `spend_cap_state` row.

**Act when:** tcp-server is ever scaled out to more than one instance.

## App spend bar refresh on other companies' pages

The breadcrumb application spend bar refetches when its own company's usage
events arrive, or when a notification arrives — not on every other company's
usage event. A change on a company the viewer isn't looking at can leave the
application bar stale until the next notification.

**Act when:** users report the application-wide spend bar looking stale.

## Spend-cap integration spec: a planner failed instead of pausing (once, in CI)

In CI on 2026-10-12 (PR #117), `spend-cap.integration-spec.ts` failed at its
second step: task A's planner settled on `failed` where the spec expected it to
pause on the spend cap. The only detail was `output: (none)`. It passed in the
same branch's previous CI run, and on five local reruns. The spec now prints the
agent's state, its assignment's and task's failure reasons, and its last ten
audit events whenever a wait fails, so the next occurrence explains itself.

**Act when:** it fails again. Read the failure message's diagnostics, find why
the planner failed, then fix the cause or the spec's timing.

## Planner-dispatched implement agent got a 404 from `complete_assignment` (not diagnosed)

During 000.02 stage 8's integration spec
(`test/integration/tcp-agent/spend-cap.integration-spec.ts`), a
planner-dispatched implement agent received a 404 from
`POST /internal/assignment/:id/complete` through the spec's fake tool, and
burned all 40 iterations retrying. It happened outside the scenario the spec
was testing, and only against a test-only fake tool — not the real
`complete_assignment` MCP tool — so the spec was changed to cancel each task
after its assertions rather than chase this down.

**Act when:** a real `complete_assignment` call (not a test fake) ever
returns 404.

## Two stacks with the bundled Zitadel can't run at once

The bundled Zitadel only works on host port 8080: `docker-compose.yml` sets `ZITADEL_EXTERNALPORT: 8080` (the port in its issuer URLs), and `start-deployment.sh`'s `zit()` bootstrap calls `localhost:8080`. `start-deployment.sh` therefore refuses any other `EXPOSE_PORT_ZITADEL`, and the wizard says the port is fixed. The other host ports can be changed per instance in the wizard (004.01), but a second bundled-Zitadel stack still collides on 8080, so it can't run while `tcp-dev` does — the test tiers included.

**Act when:** someone needs two stacks running at once. The fix is to carry one Zitadel port through `ZITADEL_EXTERNALPORT`, the bootstrap's `zit()`, the issuer URL and the port check. Until then, stop one stack before starting another (`./scripts/stop-dev.sh --project <name>`), which the port check's message says.

## Chats aren't slot-gated

`MODEL_CONCURRENCY` (000.03) limits agent runs, dispatched through tcp-agent's
worker. A chat turn runs in tcp-server instead and counts against no pool or
endpoint limit at all — it can run alongside an agent on the very same local
model.

**Act when:** a chat and an agent visibly contend for one local GPU (for
example a chat turn times out or stalls while an agent runs against the same
endpoint).

## Model slots are in-process

`ModelSlotService` (000.03) holds every pool and endpoint count in tcp-agent's
own memory, the same single-instance assumption the worker already made.

**Act when:** tcp-agent is ever run as more than one instance. The counts
would need to move to Redis.

## No notification for a used-up quota

A rate limit that classifies as `quota` (000.03) pauses the agent and waits
out `RATE_LIMIT_QUOTA_RETRY_MS`, same as a reached spend cap, but raises no
notification the way a spend cap does.

**Act when:** a user misses an out-of-credit pause — it sits paused, unnoticed,
until someone happens to look.

## One 429 doesn't hold the endpoint for other agents

A rate limit (000.03) pauses only the agent whose call was refused.
`ModelSlotService` still offers that endpoint's slot to the next waiting job
straight away, so a provider that is rate-limiting one agent can still
accept — and then also rate-limit — the very next one.

**Act when:** repeated 429s from one provider (several agents each refused in
turn) show up in practice.

## Gemini's OpenAI-compatible error body is unverified for retry hints

[docs/llm-rate-limits.md](llm-rate-limits.md) flags Gemini as the
least-verified row in its provider table: whether a native-API `RetryInfo`/
`retryDelay` reaches the OpenAI-compatible endpoint's error body was never
confirmed against a real response.

**Act when:** Gemini is used for real and rate-limits — check a captured 429
body against `classifyRateLimit` (`libs/tcp-shared/src/llm/rate-limit.ts`)
and correct the table and the classifier if it's wrong.

## Supporting services fail a task rather than pause it

When a supporting service is down, a run that notices fails with `service_unavailable`, and so does its task (000.04). 000.05 looked at pausing it instead, now that a health report exists, and found that pausing would rarely help:

- An MCP or MinIO error, reached through a tool call, goes back to the model as an ordinary tool result. It never reaches the classifier.
- The LangGraph checkpointer throws raw `pg` errors, which classify as `unexpected`.
- A database outage can't write a pause at all. Startup recovery (000.05) is the safety net for that one.
- Since 001.04, the failure's code reaches tcp-server too, and is stored as `failureCode` on the step and task.

What 000.05 did do: a run whose MCP server is down when its tools load now fails, naming the service, instead of carrying on without those tools.

**Act when:** a real outage fails a task that would have carried on cleanly once the service was back. Then pause on `service_unavailable` (the code now reaches tcp-server), and resume when `GET /api/system/health` reports that service up.

## No retry for a failed task

A failed task is terminal (000.04). Its `failureReason` says what to fix, but
the user must create a new task to try again. There is no endpoint, web button
or CLI command to run it again.

**Act when:** a user asks to rerun a task after fixing its cause.

## No CLI `close-room`

Closing a finished task's room (`POST /api/task/:id/close-visualisation`) is
available only from the office view's tray (000.04). The CLI has no office
concept, so it has no command.

**Act when:** the CLI gains an office concept.

## Chat `sendMessage` has no pause guard

A manual pause (000.04) covers a task's agents. A chat isn't part of a task and
can't be paused, so `sendMessage` has no pause check.

**Act when:** chats can be paused. Then `sendMessage` must refuse, or queue,
while a chat is paused.

## Failed or cancelled rooms get no marker

A succeeded task's room gets a tick above its whiteboard (000.04). A failed or
cancelled task's room that is still open (until closed) gets nothing: only the
tray's status says how it ended.

**Act when:** users ask for one.

## The task dialog's live agent data comes from the company stream

The dialog's "Why it's waiting" line, and its Pausing and Resume states, are
worked out from live agents, which arrive on the company stream (000.04). The
dialog opens only the task stream. Opened without the company stream, the
waiting row is only as fresh as the last fetch.

**Act when:** the dialog is ever opened outside the company page.

## `UpdateTaskDto` can't clear a task's planner

Editing a `ready` task (000.04) can set its planner but not clear it back to
the company default, because the DTO has no way to say "none".

**Act when:** a user needs to clear a task's planner.

## The TUI has no pause or resume keys

The TUI has `s` (start) and `c` (cancel) only. `pause-task` and `resume-task`
exist in the CLI and the web dialog (000.04). The TUI is due to retire in 002.07.

**Act when:** 002.07 is dropped. Then add the keys.

## `sprintf-js` advisory has no fix (21 moderate `npm audit` findings)

[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c), a
denial of service in `sprintf-js` (every version up to 1.1.3), reaches us
through `argparse@1`: in `mammoth` (runtime, but only its command-line entry
point uses `argparse`) and in the jest tool chain (dev only). `npm audit`
reports it as 21 moderate findings, one per package in those chains. Its
suggested fix downgrades jest, ts-jest and mammoth to old majors — don't take
it. The criticals and highs found alongside it were fixed by a lockfile
refresh (2026-10-09).

**Act when:** `sprintf-js` publishes a patched version (add an npm `overrides`
entry if `argparse@1` doesn't pick it up), or `mammoth` and the jest chain
drop `argparse@1`. Recheck with `npm audit --omit=dev` before any release.

## Startup recovery runs only when tcp-server boots

`AgentRecoveryService` (000.05) repairs `running` or `queued` agents that have no job, but only when tcp-server starts. If tcp-agent alone restarts or crashes, BullMQ re-dispatches its stalled jobs and, after `maxStalledCount`, fails them, which can leave the agent row `running`.

**Act when:** an agent is seen `running` with no job after a tcp-agent-only restart. Then run the stranded-agent pass on a timer as well.

## Restart needs a supervisor

Restart (000.05) exits tcp-server and tcp-agent and relies on Docker's `restart: unless-stopped` to start them again. `TCP_RESTART_SUPPORTED` is set only in `docker-compose.yml`. Elsewhere (a bare `npm run start:dev`), a restart request is refused with 409.

**Act when:** a deployment without Docker (systemd, a process manager) needs restart from the API. Then set the flag in that deployment's config, once its supervisor restarts on exit.

## The shutdown banner polls rather than streams

The web client's shutdown banner reads `GET /api/system/status`: every 30 s while idle, every 5 s during a drain or restart. The client has no app-wide event stream to carry it.

**Act when:** an app-wide event stream is added, or the poll shows up in load. Then push the shutdown state on it instead.

## No browser-tier journey for the System menu

The System menu, health dialog, shutdown dialog and banner (000.05) are covered by jsdom tests only. The browser tier signs in as a test user who isn't in `TCP_ADMIN_IDENTIFIERS`, so the menu never shows there. A browser shutdown would also stop the shared testing stack under the other specs.

**Act when:** the browser tier gains an admin sign-in. Then add a journey that opens System health, plus one that starts a drain and cancels it, run serially after the other specs.

## Transcript search scans every audit row

`GET /api/agent/search` (000.06) runs a case-insensitive `LIKE` over every
audit payload in the company. There is no text index, so the cost grows with
the company's history. Its query key sits under `agent`, so a live agent event
also refetches an open search.

**Act when:** a search takes more than about 500 ms, or a company's audit
table passes about a million rows. Add a `pg_trgm` GIN index on the payload
text (or a `tsvector` column), and move the key out from under `agent` if the
refetches show up in the network panel.

## A deleted chat lingers in other open tabs

Deleting a chat (000.06) invalidates the deleting browser's lists, but no live
event announces a deletion: `events/cache.ts` only patches and adds. Another
user, or another tab, keeps the row until it reloads, and opening it then
fails with a 404.

**Act when:** a second user of one company reports a chat that "won't open",
or any entity gains a delete that other clients must see. Add a `deleted`
event kind to the company stream and drop the row in `applyEvent`.

## The chat list re-sorts only on a status change

The chat list's order (000.06, `useActivityStamps`) moves a row when its agent
changes status: a message sent, a turn finished. A tool call finishing
mid-turn doesn't move it. That is deliberate, to stop busy chats shuffling,
but a long turn full of tool calls sits still.

**Act when:** a user asks for finer ordering. Stamp the row on a
`tool_result` audit event too, which needs those events on the company stream
or a per-row read of the agent's last event time.

## Listening in is remembered per browser

The listening-in list and its archived flags (000.06) live in `localStorage`,
per user and company. They don't follow a user to another device or browser.

**Act when:** a user asks to see their listening-in list on a second device.
Move it to a per-user server table, with routes to read and change it.

## No browser test listens in from the chat dialog

The browser tier has no LLM, so no assignment ever runs, and "Listen in on an
assignment" (000.06) always offers nothing there. It is covered by the
component tests only. This is the same gap as the office view's agents.

**Act when:** stub-llm joins the browser tier. Add a spec that starts a task,
listens in on its running assignment from the chat dialog, archives it, and
brings it back.

## No currency conversion in tcp-mcp-utilities

The utilities server has no source of exchange rates, so it offers no currency
conversion. `describe_server` tells agents to use `calculate` with a rate they
state. Agents can still pick a stale or invented rate.

**Act when:** a rates source is chosen (a configured provider URL or API). Then
add a `convert_currency` tool that reads the rate from that source and fails
loudly when no source is configured, rather than guessing.

## No holiday calendars for business-day maths

`date_math` counts Monday to Friday as business days and skips only the dates
the agent passes in `holidays`. It knows no regional holidays, so an agent that
forgets the list gets a wrong count around a bank holiday.

**Act when:** 005.02 (regional knowledge packs) lands, or a user reports a wrong
business-day count around a bank holiday. Until then agents pass `holidays`
explicitly.

## A separate records database is not backed up

`scripts/backup.sh` dumps tcp-server's database only. If `RECORDS_DATABASE_URL`
points at another database, its records are not in the archive. The migration
check in `restore.sh` also reads only tcp-server's migrations, so it ignores the
records migrations. See [tcp-mcp-records.md](tcp-mcp-records.md#a-separate-database).

**Act when:** someone first sets `RECORDS_DATABASE_URL`. Then dump that database
into the archive, and make the restore check cover `records_migrations`.

## Records audit is fire-and-forget

The records server audits every read and change, but a lost audit request does
not undo the write. A record can change without its history. See
[ADR-008](ADRs/ADR-008-audit-logging.md#amendment-as-implemented-p04-001-01).

**Act when:** an audit gap is found, or 001.04 (customer data protection) needs
a guaranteed history. Then write the audit event in the same transaction as the
change, or fail the tool call when the audit write fails.

## Plan and QA are read-only for records on the agent side only

`plan` and `qa` mode agents are not offered `create_table`, `insert`, `update`
or `delete`. The records server does no mode check of its own. Company scoping
is its security boundary.

**Act when:** an agent is seen changing records in plan or qa mode. Then pass the
mode to the records server and refuse the write tools there.

## Agents can't delete a column, narrow a key or change unique keys

These are placebos for agents (001.06), as is blanking the values a retype
can't convert. `alter_table` answers with advice to ask
a person through `request_user_input`, and the person does it in the Columns
dialog. Deleting a column or blanking values removes data from records, and a
narrower key or a new unique key can make different records count as the same
one.

**Act when:** 003.01 (action approval) lands. Make each an approval request
carrying the exact change, which the platform runs when the person approves.

## Rebuilding a record table's key reads every record

`RecordsService.rebuildKey` reads a table's records into memory to check for missing
values and clashes, and computes each key in JavaScript, because Postgres's
`jsonb` text differs from `JSON.stringify`. The table is locked while it runs.

**Act when:** changing a key, adding a unique key or retyping a key column on
a table over 10,000 records takes more than 2 seconds. Page through the records, or compute keys in SQL with a matching
encoding.

## No template table schemas for records

No ready-made tables are shipped for orders, customers, products, materials,
suppliers, income and expenses. Agents make their own.

**Act when:** 002.03 (templates) lands. Ship the schemas with the templates so
every company of one type starts with the same tables.

## Idempotency keys on outbound actions are not built

Records are safe to retry: an insert never makes a duplicate. That is the first
half of avoiding duplicate actions. The second half is not built. An action that
leaves the system, such as sending an email, has no key, so a retry could send
it twice.

**Act when:** 004.02 (email) lands. Give each outbound action a key and refuse
a second send with the same key.

## A template import can orphan records in a separate records database

A template import that replaces a company by slug deletes the old company. In a
shared database its records cascade away. In a separate records database they
stay behind. They cannot be reached, because company ids are never reused, but
they take up space.

**Act when:** `RECORDS_DATABASE_URL` is set and 002.03 imports replace companies.
Then call the records server's delete route for the replaced company, as
tcp-server does after a company delete.

## MCP server toggles have no web UI, and the estimate ignores the knowledge rule

001.01.03 added `mcpServerToggles` on companies and roles, and tool schemas
now show in `estimate-context-window`. Two gaps remain:

- The toggles can only be set through the API or `tcp-cli set-company` /
  `set-role` JSON. The web UI's company and role forms don't show them.
- The tool footprint counts `memory` even for a role with no knowledge, which
  tcp-agent leaves out, so a knowledge-less role's estimate is about 700
  tokens high.

**Act when:** 002.00 or 002.02 builds the role or company edit forms (add the
toggles there), or someone sizes a knowledge-less role near its window limit
(ask the knowledge index whether the role has chunks, as tcp-agent does).

## Company resources can't be deleted by agents

The resource tools create, replace, append and edit. None removes a resource.
A task that should retire a resource (an old price list, a withdrawn policy)
has no way to do it. A user can still delete the file in the MinIO console, and
versioning keeps the old version.

**Act when:** a task needs to remove a resource. Add a delete that is a draft
like any other change (a marker applied on success), not an immediate removal.

## Two tasks changing one resource: last write wins

Apply copies a task's draft over the live resource. If two tasks change the same
resource, the one that succeeds last wins, and the other task's change is
overwritten without a warning. Versioning keeps the older content, so nothing
is lost for good.

**Act when:** the first lost update is seen, or when 004.01 (recurring tasks)
lands and tasks can overlap on a schedule. Then check the live resource's
version at apply time against the version the draft started from.

## Resources are text only

An agent can read and write only text resources. A PDF invoice, an image or an
office document is refused with a reply that says it can't be read as text.

**Act when:** 006.02 (images) lands, or a real need for PDFs appears (for
example invoices that must be sent as PDF).

## The context estimate doesn't count the mode prompt

`estimate-context-window` counts bound tool schemas, but not the mode prompt
text. With every server on, that text is up to about 540 tokens (plan mode),
so a small-window role can pass the estimate and still run out of room.

**Act when:** a small-window role fails for lack of context despite a passing
estimate. Count `modePrompt(mode, serverNames)` for each mode in the estimate.

## Versioning covers the whole bucket

Bucket versioning keeps old versions of working files too, not just resources.
Frequent working-file edits add versions that are rarely wanted. They expire
after `STORAGE_VERSION_RETENTION_DAYS` (default 90), but they take space until
then.

**Act when:** version storage grows too large (check the bucket's size against
its live data). The upgrade is a separate versioned bucket for resources only.

## One lifecycle rule per company

`StorageVersioningService` writes one lifecycle rule for each company prefix,
plus one for `_deleted/`. S3 allows about 1,000 rules per bucket. A deleted
company's rule also stays until the next boot.

**Act when:** a deployment nears about 800 companies. Switch to one default rule
plus rules only for companies with their own `versionRetentionDays`.

## Sensitive resource changes need user approval

Today a task's resource changes are applied when it succeeds, with QA as the
only review. Some changes (prices, policies) should wait for a person. This
moved to 003.01 (action approval), which has a section for it:
[003.01 prompt](prompts/phase%2004%20-%20utility/003.01.00.prompt%20-%20action%20approval%20%28draft%29.md).

**Act when:** the core of 003.01 lands. Then let a folder's `README.md` mark it
sensitive, and pause apply until a user approves.

## Live record tables re-read whole tables

When a table changes elsewhere (001.05), each person with it open reads the
whole table again (up to 10,000 rows), at most once a second, to see what
changed. The company stream carries only `{entity, action, table}`, so the
browser can't tell which rows changed without reading them. A `ponytail:`
comment on `RECORD_CHANGE_WINDOW_MS` names the ceiling.

**Act when:** a table over 5,000 rows is open while an agent writes to it
steadily, and the reads show up as slow (in the browser or tcp-server). Then
add the changed row's id and version to the signal for single-row changes, and
read only those rows. Keep the whole-table read for bulk changes, which name no
rows.

## A slow save can briefly read as a change elsewhere

The sheet tells a person's own change apart by version: their save patches both
the screen and the fresher copy. If that save's response takes longer than the
1s gathering window plus a table read, the fresher copy arrives first. The
row is then marked "changed elsewhere", and the one announcement is made, until
the response lands and the mark clears.

**Act when:** someone reports a "changed elsewhere" notice for their own edit.
Then hold the announcement until no save is in flight for that table.

## Clear and delete are open to every company member

Any member of a company can edit rows, clear a table and delete a table. There
are no role flags yet. Clear and drop keep a count in the audit trail, not the
rows.

**Act when:** membership role flags exist (see 003.01). Then limit clear and
delete to owners.

## Record exports are built in memory

`GET tables/:table/csv` and `GET export` build the whole file in memory before
they send it. The zip is built with `fflate`'s `zipSync`. A `ponytail:` comment
in the code names the ceiling.

**Act when:** an export passes about 50 MB, or tcp-server memory alerts fire
during one. Stream it instead: `forEachRowBatch` already reads in batches, and
`fflate`'s `Zip` class can write a zip as it goes.

## The record sheet shows at most 10,000 rows

`GET tables/:table` returns the 10,000 most recently changed rows and sets
`truncated`. A larger table shows only those, and the sheet says so. Exports
have no cap.

**Act when:** a table reaches 10,000 rows. Page the read on the server (keyset
by id), or filter on the server, and load pages into the sheet.

## Record tables have no create-table screen

`POST /api/company/:id/records/tables` exists, and is audited as the user, but
the web UI has no form for it. Tests, tools and templates use the route. People
can only get a table by asking an agent for one.

**Act when:** 002.03 (templates) lands, or a user asks to make a table by hand.
Add a form built on the same JSON Schema rules.

## AG Grid UI strings bypass `t()`

The sheet's filter menus, pagination ("Page 1 of 1") and similar text come from
AG Grid's own English locale, not from `src/strings.ts`.

**Act when:** translation work starts. Register AG Grid's `LocaleModule` and
give the grid a `getLocaleText` callback that looks each key up through `t()`,
falling back to AG Grid's default. Comments in
`apps/frontend/tcp-frontend/src/components/RecordSheet/RecordSheet.tsx` mark
the places to change, including the "Updated" column's date format, which
follows the browser's locale.

## `MaskSecretsInterceptor` flattens a returned `StreamableFile`

The global interceptor walks every returned value as a plain object, so a
route that returns a Nest `StreamableFile` sends JSON instead of the file. The
records downloads avoid it by writing to `@Res()` directly.

**Act when:** another route needs to return a `StreamableFile`. Teach the
interceptor to pass it (and other streams) through untouched.

## Record sheet screen-reader pass is not done

The sheet has axe checks in all three tiers and a keyboard-only browser test.
It has not had a manual VoiceOver or NVDA pass: cell, header and sort
announcements, and entering and leaving edit mode.

**Act when:** before the phase 04 release, or at the next ADR-026 manual matrix
run, whichever comes first. Record the findings in the 001.03 plan's outcome.

## Data protection reaches record tables only

001.04's search, export and delete cover record tables. The audit log (including LLM requests and responses), task transcripts, knowledge, company resources, files, agents' memory and backups can still hold a person's details, and the do-not-store list doesn't stop agents writing them there. The Data protection page says so.

**Act when:** a real erasure or subject access request needs one of these stores, or agents are seen putting customer details outside record tables. Start with the audit log, which holds LLM traffic.

## Do-not-store check can miss a write made as an entry is added

The check runs just before an agent's write, outside its transaction (`RecordsService.doNotStoreMatches`).

**Act when:** a record is found that matches an entry added before it was stored. Then lock the list for the duration of the write.

## Retention deletes whole rows only

A table's retention deletes rows; it can't blank one field (the address) and keep the rest (the order). Agents can't set retention, and templates don't carry it.

**Act when:** someone needs an order kept after its customer's address is due to go, or 002.03 (templates) lands, which should carry retention and the ICO note.

## Data protection has no CLI verbs or office entry

Search, the do-not-store list and retention are in the web Admin tab (Data protection) and the REST API only.

**Act when:** someone asks to manage them from the CLI or the office view.

## Rate-limit pauses and enquiries have no limit

A run paused for rate limits resumes forever (000.03, by design), and an agent waiting on `request_user_input` waits forever. 001.04 gave agents `fail_assignment` with `information_unavailable`, but nothing makes them use it after a wait.

**Act when:** a task is found stuck for days on either.

## Knowledge index status is polled, not pushed

Nothing streams a knowledge index. The knowledge panel (002.00) asks for the status every 3 seconds while a rebuild runs, and not otherwise (`useKnowledgeStatus`). A rebuild started elsewhere shows only on Refresh or reopening the panel.

**Act when:** knowledge changes join the company event stream, or a rebuild started by an agent or the CLI needs to show without a refresh.

## Any member can delete roles and knowledge

Admin → Roles and the knowledge panel let every member of a company delete roles, their knowledge and the company's shared knowledge. Membership is still the only access control (ADR-011); the permission flags aren't built.

**Act when:** the permission flags land (phase 06 002.01). Gate role and knowledge changes on `define_agent_roles` / `modify_company`.

## Knowledge uploads show no progress

`fetch` reports no upload progress, so the panel says what is uploading and offers Cancel, but not how far along it is.

**Act when:** people upload files big enough that the wait is confusing (tens of MB on a slow link). Switch the upload to `XMLHttpRequest`, which reports progress.

## Storage uploads are read whole before their size is checked

`POST /api/storage` checks its 50 MB limit with a `ParseFilePipe`, which runs after the whole file is in memory. Knowledge uploads (002.00) use multer's `limits.fileSize` instead, which stops reading at the limit.

**Act when:** the storage proxy is reachable by anyone untrusted, or memory pressure is seen on tcp-server. Give its `FileInterceptor` the same `limits` (`MAX_UPLOAD_BYTES` in `api/upload-limit.ts`).

## The web client retries 4xx answers

The app's `QueryClient` (`main.tsx`) uses TanStack's default: 3 retries with back-off, for every error. A 404 for something just deleted is retried for about 7 seconds. In 002.00 that made "Delete table" seem slow; `useDropRecordTable` now forgets the dropped table's queries, which fixed that case only.

**Act when:** [002.09](prompts/phase%2004%20-%20utility/002.09.00.prompt%20-%20web%20client%20request%20retry%20policy%20%28draft%29.md) (web client request retry policy) is planned; it replaces this with one shared policy. Sooner if another "slow after a delete" or "waits after a 403" symptom appears.

## A deleted default planner can't be replaced in the browser

Deleting the company's default planner role (Admin → Roles warns about it) clears `plannerRoleId`. Tasks without their own planner then won't start, and only `tcp-cli` can set a new one.

**Act when:** 002.02 (create and edit a company) lands; it should let a person choose the planner.
