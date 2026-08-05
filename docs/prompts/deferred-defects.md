A few defects have popped up during manual testing. Please prepare a plan to repair these.

## Finalisation assignment status

When the finalisation assignment of a task completes, the task moves to state `succeeded` but the finalisation task remains `in-progress`.

## start-dev.sh tcp-cli guidance

The `start-dev.sh` script prints some guidance at the end, including:

```
Get a token (opens a browser for login):
  npx tcp-cli get-token
```

This doesn't work - as `tcp-cli` isn't in the registry.npmjs.org registry.

It's easier just to use `tcp-cli.sh` in the guidance for now and, in fact, probably even better to suggest:

```
Put a token into TCP_TOKEN to use it in subsequent calls.
(This will open a browser for login.)
  export TCP_TOKEN=$(./tcp-cli.sh get-token)
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

## Documentation corrections

### `your-first-company.md`

The default account described here has fallen behind current configuration. Correct values are from `.env.testing` and are:

- Username: `test`
- Password: `Testing123!`

Please also add a `> ![TIP]` explaining where these come from to help the user familiarise themselves with the config.
