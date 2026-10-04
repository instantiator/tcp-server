#!/usr/bin/env bash
set -euo pipefail

# Restores a TCP stack from an archive written by scripts/backup.sh: both
# Postgres databases, every MinIO bucket and (if archived) the Zitadel PAT.
# Destructive — the project's current data is replaced. See
# docs/backup-and-restore.md.

usage() {
  cat <<EOF
Usage: $(basename "$0") --project <name> (--env-file <path> | --env-files <f1,f2,...>) --archive <path> [--yes] [-- <start-deployment args>]

Replace the data in a TCP Docker Compose project with the contents of a backup
archive, then start the stack with scripts/start-deployment.sh.

Works on a running stack or on one that has never been started (a new
machine): it starts postgres, redis and minio itself. The current databases,
objects and queued jobs are discarded.

Options:
  --project <name>        Docker Compose project name (required)
  --env-file <path>       Env file the stack runs with (required, single file)
  --env-files <f1,f2,...> Comma-separated env files in precedence order
  --archive <path>        Archive written by scripts/backup.sh (required)
  --yes                   Don't ask for confirmation (needed without a terminal)
  -h, --help              Show this help message and exit

Arguments after -- are passed to start-deployment.sh (e.g. -- --dev-ports).

The env files must be the ones the backed-up stack used: ZITADEL_MASTERKEY
decrypts the restored Zitadel data.
EOF
}

PROJECT=""
ENV_FILE=""
ENV_FILES=""
ARCHIVE=""
YES=false
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      [[ -n "${2:-}" ]] || { echo "ERROR: --project requires a value" >&2; exit 1; }
      PROJECT="$2"; shift 2 ;;
    --env-file)
      [[ -n "${2:-}" ]] || { echo "ERROR: --env-file requires a path" >&2; exit 1; }
      ENV_FILE="$2"; shift 2 ;;
    --env-files)
      [[ -n "${2:-}" ]] || { echo "ERROR: --env-files requires a comma-separated list" >&2; exit 1; }
      ENV_FILES="$2"; shift 2 ;;
    --archive)
      [[ -n "${2:-}" ]] || { echo "ERROR: --archive requires a path" >&2; exit 1; }
      ARCHIVE="$2"; shift 2 ;;
    --yes) YES=true; shift ;;
    --) shift; EXTRA_ARGS=("$@"); break ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

[[ -n "$PROJECT" ]] || { echo "ERROR: --project is required" >&2; usage >&2; exit 1; }
[[ -n "$ENV_FILE" || -n "$ENV_FILES" ]] || { echo "ERROR: --env-file or --env-files is required" >&2; usage >&2; exit 1; }
[[ -n "$ARCHIVE" ]] || { echo "ERROR: --archive is required" >&2; usage >&2; exit 1; }
[[ -f "$ARCHIVE" ]] || { echo "ERROR: archive not found: $ARCHIVE" >&2; exit 1; }

for tool in docker tar; do
  command -v "$tool" >/dev/null || { echo "ERROR: $tool is required but not installed." >&2; exit 1; }
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/lib/load-env.sh
# shellcheck disable=SC1091 # source path resolved at runtime
source "$REPO_ROOT/scripts/lib/load-env.sh"
# shellcheck source=scripts/lib/errors.sh
# shellcheck disable=SC1091 # source path resolved at runtime
source "$REPO_ROOT/scripts/lib/errors.sh"
enable_error_report

# Load the stack's env, the same way start-deployment.sh does.
if [[ -n "$ENV_FILES" ]]; then
  IFS=',' read -ra ENV_FILES_ARRAY <<< "$ENV_FILES"
  for f in "${ENV_FILES_ARRAY[@]}"; do
    [[ -f "$f" ]] || { echo "ERROR: env file not found: $f" >&2; exit 1; }
  done
  set -a
  load_env_files "${ENV_FILES_ARRAY[@]}"
  set +a
  ENV_FILE="${ENV_FILES_ARRAY[0]}"
  ENV_ARGS=(--env-files "$ENV_FILES")
else
  [[ -f "$ENV_FILE" ]] || { echo "ERROR: env file not found: $ENV_FILE" >&2; exit 1; }
  set -a
  # shellcheck disable=SC1090 # env file path is only known at runtime
  source "$ENV_FILE"
  set +a
  ENV_ARGS=(--env-file "$ENV_FILE")
fi
LOCAL_ENV_FILE="${ENV_FILE}.local"
touch "$LOCAL_ENV_FILE"
set -a
# shellcheck disable=SC1090 # env file path is only known at runtime
source "$LOCAL_ENV_FILE"
set +a

DB_USER="${DB_USER:-tcp}"
DB_NAME="${DB_NAME:-tcp}"
AUTH_PROFILE=""
[[ -z "${ZITADEL_ADMIN_PASSWORD:-}" ]] || AUTH_PROFILE="--profile auth"
DC="docker compose -p $PROJECT -f $REPO_ROOT/docker-compose.yml $AUTH_PROFILE --env-file $ENV_FILE --env-file $LOCAL_ENV_FILE"
PAT_FILE="$REPO_ROOT/docker/zitadel-machinekey/$PROJECT/pat.txt"

# Unpack into a private staging dir, removed on exit.
umask 077
STAGE="$(mktemp -d)"
cleanup() {
  rm -rf "$STAGE"
  $DC exec -T minio rm -rf /tmp/tcp-restore-objects >/dev/null 2>&1 || true
}
trap cleanup EXIT
step "unpacking $ARCHIVE" "Is it a .tar.gz written by scripts/backup.sh?"
tar -xzf "$ARCHIVE" -C "$STAGE"

# Read the manifest as data: it came from a file, so it is never sourced.
manifest() {
  grep -E "^$1=" "$STAGE/manifest.env" | head -1 | cut -d= -f2- || true
}
[[ -f "$STAGE/manifest.env" ]] || { echo "ERROR: $ARCHIVE has no manifest.env — not a backup.sh archive." >&2; exit 1; }
FORMAT="$(manifest FORMAT)"
LATEST_MIGRATION="$(manifest LATEST_MIGRATION)"
[[ "$FORMAT" == 1 ]] || { echo "ERROR: archive format '$FORMAT' is not supported (expected 1)." >&2; exit 1; }
[[ -f "$STAGE/tcp.dump" ]] || { echo "ERROR: $ARCHIVE has no tcp.dump." >&2; exit 1; }

# Refuse a backup newer than this code: tcp-server migrates an older schema
# forward at boot, but cannot run against one it has never heard of.
if [[ ! "$LATEST_MIGRATION" =~ ^[A-Za-z0-9_]+$ ]] \
  || ! grep -rqE "class ${LATEST_MIGRATION}[^A-Za-z0-9_]" "$REPO_ROOT/apps/backend/apps/tcp-server/src/migrations/"; then
  cat >&2 <<EOF
ERROR: the backup's latest migration ('$LATEST_MIGRATION') is not in this checkout.
The backup was taken by a newer version of TCP. Check out that version (commit
$(manifest GIT_COMMIT)) and restore from there.
EOF
  exit 1
fi

# Without the PAT that matches the restored Zitadel, start-deployment.sh can't
# reconfigure it — fail now rather than after the data has been replaced.
if [[ -f "$STAGE/zitadel.dump" && -n "$AUTH_PROFILE" && ! -f "$STAGE/pat.txt" && ! -s "$PAT_FILE" ]]; then
  cat >&2 <<EOF
ERROR: the archive holds Zitadel data but no pat.txt, and $PAT_FILE doesn't exist.
Put the original stack's pat.txt there (see docs/backup-and-restore.md), or
take the backup with --include-pat.
EOF
  exit 1
fi

# Confirm: this discards the project's current data.
echo "Restoring $(manifest PROJECT) backup from $(manifest CREATED) into project '$PROJECT'."
echo "This replaces the project's databases, objects and queued jobs."
if [[ "$YES" != true ]]; then
  if [[ ! -t 0 ]]; then
    echo "ERROR: no terminal to confirm on; pass --yes." >&2
    exit 1
  fi
  read -r -p "Type the project name to continue: " answer
  [[ "$answer" == "$PROJECT" ]] || { echo "Cancelled." >&2; exit 1; }
fi

# Stop everything that writes, then make sure the data services are up.
step "stopping the application services" "Docker's own error is above."
$DC stop tcp-web tcp-mcp-storage tcp-mcp-memory tcp-mcp-interactions tcp-mcp-tasks tcp-agent tcp-server
[[ -z "$AUTH_PROFILE" ]] || $DC stop zitadel
step "starting postgres, redis and minio" "Docker's own error is above. 'port is already allocated' means another stack holds the port."
$DC up -d --wait postgres redis minio

# Replace each database with its dump.
restore_db() {
  local db="$1" dump="$2"
  step "restoring the $db database" "pg_restore's own error is above."
  $DC exec -T postgres psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -q \
    -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" \
    -c "CREATE DATABASE \"$db\" OWNER \"$DB_USER\""
  $DC exec -T postgres pg_restore -U "$DB_USER" --no-owner --role="$DB_USER" -d "$db" < "$dump"
}
restore_db "$DB_NAME" "$STAGE/tcp.dump"
[[ ! -f "$STAGE/zitadel.dump" ]] || restore_db zitadel "$STAGE/zitadel.dump"

# Queued jobs refer to the replaced data; drop them rather than replay them.
step "clearing the job queues" "Docker's own error is above."
$DC exec -T redis redis-cli FLUSHALL >/dev/null

# Replace each archived bucket's contents. A live bucket the archive doesn't
# have is left alone and reported.
step "restoring the MinIO objects" "mc's own error is above."
mkdir -p "$STAGE/objects"
$DC cp "$STAGE/objects/." minio:/tmp/tcp-restore-objects
# shellcheck disable=SC2016 # expands inside the container, where the MinIO credentials are set
$DC exec -T minio sh -c '
  set -e
  mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
  for dir in /tmp/tcp-restore-objects/*/; do
    [ -d "$dir" ] || continue
    bucket="$(basename "$dir")"
    mc mb --ignore-existing "local/$bucket" >/dev/null
    mc mirror --quiet --overwrite --remove "$dir" "local/$bucket"
  done
  # No awk in this image: the bucket name is the last field of each line.
  mc ls local | while read -r line; do
    bucket="${line##* }"; bucket="${bucket%/}"
    [ -d "/tmp/tcp-restore-objects/$bucket" ] || echo "WARNING: bucket $bucket is not in the archive; left as it was." >&2
  done
'

# Put the archived PAT back. Replace the directory entry rather than write into
# the file: on Linux it belongs to Zitadel's uid.
if [[ -f "$STAGE/pat.txt" ]]; then
  step "restoring the Zitadel PAT" ""
  mkdir -p "$(dirname "$PAT_FILE")"
  chmod 777 "$(dirname "$PAT_FILE")"
  cp "$STAGE/pat.txt" "$PAT_FILE.restore"
  mv -f "$PAT_FILE.restore" "$PAT_FILE"
fi

# Start the stack. start-deployment.sh re-syncs the OIDC client secrets with
# the restored Zitadel; tcp-server applies any newer migrations at boot. Its
# port check counts this project's own containers, so stop them first.
echo ""
echo "Data restored. Starting the stack..."
step "starting the stack" "The data is restored; fix the error above and run start-deployment.sh with the same arguments."
$DC stop postgres redis minio
"$REPO_ROOT/scripts/start-deployment.sh" --project "$PROJECT" "${ENV_ARGS[@]}" ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
