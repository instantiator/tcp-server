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

When a supporting service is down (storage, Redis, the database, an MCP
service), a run fails with `service_unavailable` and so does its task (000.04).
Pausing the task, so it could be resumed once the service is back, would be
kinder, but nothing yet tells the system a service is healthy again.

**Act when:** 000.05's health signal exists. Then pause instead of fail, and
resume when the service reports healthy.

## No retry for a failed task

A failed task is terminal (000.04). Its `failureReason` says what to fix, but
the user must create a new task to try again. There is no endpoint, web button
or CLI command to run it again.

**Act when:** a user asks to rerun a task after fixing its cause.

## A `running` agent is stranded when the failure write itself fails

If saving an agent's failure throws (the database is down, say), `failRun`
logs the code and reason and still tells tcp-server, which fails the task
(000.04). But the agent row stays `running`, since the write that would have
changed it failed.

**Act when:** a stranded agent is seen (a `running` agent on a failed task).
The fix belongs in startup recovery: mark a `running` agent with no live job
as failed.

## An MCP server that is down at tool-load time is skipped quietly

`McpClientService.loadTools` skips a server it can't reach, so the failure
never reaches the run-failure classifier (000.04) and gets no
`service_unavailable` reason. The agent just runs without those tools.

**Act when:** a run ends oddly (a required tool is missing, or the agent gives
up) because a tool server was down. Then make `loadTools` report it.

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
