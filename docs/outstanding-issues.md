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

**Act when:** the browser tier fails this way again. `run-browser-tests.sh`
now keeps each failed run's traces in `.tmp/browser-failures/<timestamp>/`.
Open the failing test's trace with `npx playwright show-trace`. It will show whether the page was
loading, showing an error or redirecting to sign-in. Don't add retries;
`playwright.config.ts` explains why.

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

## Two stacks with the bundled Zitadel can't run at once

The bundled Zitadel only works on host port 8080: `docker-compose.yml` sets `ZITADEL_EXTERNALPORT: 8080` (the port in its issuer URLs), and `start-deployment.sh`'s `zit()` bootstrap calls `localhost:8080`. `start-deployment.sh` therefore refuses any other `EXPOSE_PORT_ZITADEL`, and the wizard says the port is fixed. The other host ports can be changed per instance in the wizard (004.01), but a second bundled-Zitadel stack still collides on 8080, so it can't run while `tcp-dev` does — the test tiers included.

**Act when:** someone needs two stacks running at once. The fix is to carry one Zitadel port through `ZITADEL_EXTERNALPORT`, the bootstrap's `zit()`, the issuer URL and the port check. Until then, stop one stack before starting another (`./scripts/stop-dev.sh --project <name>`), which the port check's message says.
