# Outstanding issues

Known defects and deferred work, each with the condition that should trigger
acting on it. Not a backlog of features — this is for things already found and
knowingly left, so they stay visible instead of being rediscovered.

Resolve an entry by deleting it, in the change that resolves it.

## Finalisation assignment status

When the finalisation assignment of a task completes, the task moves to state `succeeded` but the finalisation task remains `in-progress`.

## `start-dev.sh` tcp-cli guidance

The `start-dev.sh` script prints some guidance at the end, including:

```
Get a token (opens a browser for login):
  npx tcp-cli get-token
```

This doesn't work - as `tcp-cli` isn't in the registry.npmjs.org registry.

It's easier just to use `tcp-cli.sh` in the guidance for now and, in fact, probably even better to give guidance like this:

```
Put a token into TCP_TOKEN to use it in subsequent calls. (This will open a browser for login.)
  export TCP_TOKEN=$(./tcp-cli.sh get-token)
```

It would also be nice to print this advice right at the end, but only if there are 0 companies already configured:

```
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
