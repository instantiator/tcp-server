# Backup and restore

`scripts/backup.sh` copies a stack's data into one archive file.
`scripts/restore.sh` puts it back, on the same machine or a new one. Run both
from the repository root, against a stack started with `start-deployment.sh`.

## Take a backup

```bash
./scripts/backup.sh --project tcp-dev --env-file .env.dev
```

The stack keeps running. The archive is written to
`backups/<project>-<UTC time>.tar.gz` (or `--output <dir>`). Only the user who
ran the script can read it (mode 600). `backups/` is gitignored.

Add `--include-pat` if you might restore onto a new machine and don't keep the
PAT anywhere else (see [What you must keep safe](#what-you-must-keep-safe)).

## What is in an archive

| File                | What it is                                                                    |
| ------------------- | ----------------------------------------------------------------------------- |
| `manifest.env`      | Format version, time, project, git commit, latest migration, Postgres version |
| `tcp.dump`          | The application database (`pg_dump -Fc`)                                      |
| `zitadel.dump`      | Zitadel's database (users, sign-in clients), if the stack uses Zitadel        |
| `objects/<bucket>/` | Every MinIO object                                                            |
| `pat.txt`           | Zitadel's bootstrap admin token, only with `--include-pat`                    |

Not included, on purpose:

- **Redis.** It only holds the job queues. On restore, Redis is emptied so old
  jobs can't run against the restored data. Jobs that were queued or running at
  backup time are lost. Start them again after a restore.
- **Env files.** They hold secrets, so they stay out of the archive.

The archive is not encrypted. It holds every company's records and the LLM API
keys saved in company and role settings. Treat it like the database itself.

## What you must keep safe

Keep these somewhere safe, apart from the archives:

- **The env file and its `.local` file** (for example `.env.dev` and
  `.env.dev.local`). `ZITADEL_MASTERKEY` decrypts Zitadel's data, so a restore
  needs the same value.
- **Zitadel's PAT**, at `docker/zitadel-machinekey/<project>/pat.txt`, unless
  your backups use `--include-pat`. A restore onto a new machine needs the PAT
  that matches the restored Zitadel. A restore on the same machine already has
  it.

## Restore

```bash
./scripts/restore.sh --project tcp-dev --env-file .env.dev \
  --archive backups/tcp-dev-20261004T161924Z.tar.gz
```

This **replaces** the project's data. It asks you to type the project name
first. Pass `--yes` to skip that, for example in a script.

What it does:

1. Checks the archive before touching anything (see [Versions](#versions)).
2. Stops the application services and Zitadel, and starts Postgres, Redis and
   MinIO if they aren't running.
3. Replaces both databases, empties Redis and makes each bucket match the
   archive.
4. Puts `pat.txt` back, if the archive has one.
5. Runs `start-deployment.sh`. That creates new sign-in client secrets in the
   restored Zitadel and starts everything.

Anything after `--` is passed to `start-deployment.sh`, for example
`-- --dev-ports`.

### On a new machine

1. Clone the repository and check out the commit in the archive's manifest, or
   a newer one.
2. Copy in the env file and its `.local` file.
3. If the archive has no `pat.txt`, copy the saved one to
   `docker/zitadel-machinekey/<project>/pat.txt`.
4. Run `restore.sh` as above. You don't need to start the stack first.

## Versions

- **An older backup is fine.** tcp-server applies any newer migrations when it
  starts.
- **A newer backup is refused.** If the archive's latest migration isn't in
  your checkout, restore stops before changing anything. Check out the commit
  named in the error.
- **Postgres major version.** The dumps restore into the `pgvector/pgvector`
  image in `docker-compose.yml`. A restore across a major version change hasn't
  been tested.

## Consistency

The backup runs while the stack runs. Each database dump is consistent on its
own. Objects are copied after the dumps, so every object a row refers to is in
the archive. An object written during the backup may be included without a
row that refers to it. That does no harm.

## Testing

`scripts/run-backup-tests.sh` tests the whole round trip. It runs in
`run-all-tests.sh` and in CI's `backup-test` job. See
[testing.md](testing.md#backup-tests).
