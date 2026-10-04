#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") --project <name> (--env-file <path> | --env-files <f1,f2,...>) [--output <dir>] [--include-pat] [-h|--help]

Hot backup of a running TCP Docker Compose stack: dumps the Postgres
databases and mirrors the MinIO buckets into one dated archive.

The stack is not stopped — Postgres is dumped with pg_dump (a consistent
snapshot of a live database) and MinIO objects are mirrored directly. This
does not pause writes, so a backup running during heavy use may interleave
a slightly later object with a slightly earlier database row; this script
dumps the databases first precisely to make that safe (see the "Objects"
step below).

Options:
  --project <name>        Docker Compose project name (required)
  --env-file <path>       Path to the env file (required, single file)
  --env-files <f1,f2,...> Comma-separated env files in precedence order (first wins)
  --output <dir>          Directory to write the archive into (default: ./backups)
  --include-pat           Also include the Zitadel bootstrap PAT
                           (docker/zitadel-machinekey/<project>/pat.txt) in the archive
  -h, --help              Show this help message and exit

Example:
  $(basename "$0") --project tcp-dev --env-file .env.dev
EOF
}

PROJECT=""
ENV_FILE=""
ENV_FILES=""
OUTPUT=""
INCLUDE_PAT=false

# Parse arguments.
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
    --output)
      [[ -n "${2:-}" ]] || { echo "ERROR: --output requires a path" >&2; exit 1; }
      OUTPUT="$2"; shift 2 ;;
    --include-pat) INCLUDE_PAT=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

[[ -n "$PROJECT" ]] || { echo "ERROR: --project is required" >&2; usage >&2; exit 1; }
[[ -n "$ENV_FILE" || -n "$ENV_FILES" ]] || { echo "ERROR: --env-file or --env-files is required" >&2; usage >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/lib/load-env.sh
# shellcheck disable=SC1091 # source path resolved at runtime
source "$REPO_ROOT/scripts/lib/load-env.sh"
# shellcheck source=scripts/lib/errors.sh
# shellcheck disable=SC1091 # source path resolved at runtime
source "$REPO_ROOT/scripts/lib/errors.sh"
enable_error_report

# The archive holds a copy of the running stack's business data (Postgres
# rows, MinIO objects) — keep it unreadable to anyone but the invoking user.
umask 077

for tool in docker tar; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: required tool '$tool' not found on PATH" >&2; exit 1; }
done

OUTPUT="${OUTPUT:-$REPO_ROOT/backups}"

# Load env files: same precedence convention as start-deployment.sh (first
# file in --env-files wins; a single --env-file is sourced directly).
if [[ -n "$ENV_FILES" ]]; then
  IFS=',' read -ra ENV_FILES_ARRAY <<< "$ENV_FILES"
  for f in "${ENV_FILES_ARRAY[@]}"; do
    [[ -f "$f" ]] || { echo "ERROR: env file not found: $f" >&2; exit 1; }
  done
  echo "Loading env files (precedence order): ${ENV_FILES_ARRAY[*]}"
  set -a
  load_env_files "${ENV_FILES_ARRAY[@]}"
  set +a
  ENV_FILE="${ENV_FILES_ARRAY[0]}"
else
  [[ -f "$ENV_FILE" ]] || { echo "ERROR: env file not found: $ENV_FILE" >&2; exit 1; }
  echo "Using: $ENV_FILE"
  set -a
  # shellcheck disable=SC1090 # env file path is only known at runtime
  source "$ENV_FILE"
  set +a
fi

# Gitignored per-instance override (see start-deployment.sh). Touched so the
# docker compose --env-file flag below always has a file to read, even when
# no override has ever been written for this project.
LOCAL_ENV_FILE="${ENV_FILE}.local"
touch "$LOCAL_ENV_FILE"
set -a
# shellcheck disable=SC1090 # env file path is only known at runtime
source "$LOCAL_ENV_FILE"
set +a

DC="docker compose -p $PROJECT -f $REPO_ROOT/docker-compose.yml --env-file $ENV_FILE --env-file $LOCAL_ENV_FILE"

step "checking the stack is running" \
  "Start it first: ./scripts/start-deployment.sh --project $PROJECT --env-file $ENV_FILE"
RUNNING_SERVICES="$($DC ps --status running --services)"
for svc in postgres minio; do
  if ! grep -qx "$svc" <<<"$RUNNING_SERVICES"; then
    echo "ERROR: service '$svc' is not running in project '$PROJECT'." >&2
    echo "Start the stack first: ./scripts/start-deployment.sh --project $PROJECT --env-file $ENV_FILE" >&2
    exit 1
  fi
done

DB_USER="${DB_USER:-tcp}"
DB_NAME="${DB_NAME:-tcp}"

# Staging directory for the files that go into the archive, removed on exit.
# Best-effort cleanup of the MinIO container's scratch copy too, in case the
# objects step below is interrupted before its own removal runs.
STAGE=""
cleanup() {
  [[ -z "$STAGE" ]] || rm -rf "$STAGE"
  $DC exec -T minio rm -rf /tmp/tcp-backup-objects >/dev/null 2>&1 || true
}
trap cleanup EXIT
STAGE="$(mktemp -d)"

step "dumping the $DB_NAME database" \
  "pg_dump's own output is above. Check the postgres container's logs: $DC logs postgres"
$DC exec -T postgres pg_dump -U "$DB_USER" -Fc "$DB_NAME" > "$STAGE/tcp.dump"

# Zitadel's own database, when the auth profile created one, is dumped
# alongside the application database — restoring one without the other would
# leave sign-in and the app disagreeing about who exists.
if $DC exec -T postgres psql -U "$DB_USER" -lqt | cut -d'|' -f1 | tr -d ' ' | grep -qx zitadel; then
  step "dumping the zitadel database" \
    "pg_dump's own output is above. Check the postgres container's logs: $DC logs postgres"
  $DC exec -T postgres pg_dump -U "$DB_USER" -Fc zitadel > "$STAGE/zitadel.dump"
fi

step "reading the applied migration and server version" \
  "psql's own output is above. Check the postgres container's logs: $DC logs postgres"
LATEST_MIGRATION="$($DC exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -tAc 'SELECT name FROM migrations ORDER BY timestamp DESC LIMIT 1')"
PG_VERSION="$($DC exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -tAc 'SHOW server_version')"

# Objects, deliberately AFTER both database dumps above: by the time this
# runs, every object a dumped row refers to already exists in MinIO, so the
# dump and the mirror can never disagree about an object that's missing.
# Mirroring before the dump could instead miss an object that a row written
# moments later refers to. An object with no referring row (created after the
# dump, before the mirror) is merely an orphan, and harmless.
step "collecting MinIO objects" \
  "mc's own output is above. Check the minio container's logs: $DC logs minio"
# shellcheck disable=SC2016 # single-quoted deliberately: $MINIO_ROOT_USER/
# $MINIO_ROOT_PASSWORD must expand inside the container's shell, not this one.
$DC exec -T minio sh -c 'mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"' >/dev/null

BUCKETS=()
while IFS= read -r line; do
  [[ -n "$line" ]] || continue
  bucket="${line##* }"
  bucket="${bucket%/}"
  BUCKETS+=("$bucket")
done < <($DC exec -T minio mc ls local)

if [[ ${#BUCKETS[@]} -gt 0 ]]; then
  for bucket in "${BUCKETS[@]}"; do
    # Created first so an empty bucket is still archived (and cp has a source).
    $DC exec -T minio mkdir -p "/tmp/tcp-backup-objects/$bucket"
    $DC exec -T minio mc mirror --quiet "local/$bucket" "/tmp/tcp-backup-objects/$bucket"
  done
  $DC cp minio:/tmp/tcp-backup-objects "$STAGE/objects"
  $DC exec -T minio rm -rf /tmp/tcp-backup-objects
else
  mkdir -p "$STAGE/objects"
fi

step "writing the manifest" "Disk may be full — check available space on $STAGE."
GIT_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
cat > "$STAGE/manifest.env" <<EOF
FORMAT=1
CREATED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
PROJECT=$PROJECT
GIT_COMMIT=$GIT_COMMIT
LATEST_MIGRATION=$LATEST_MIGRATION
PG_VERSION=$PG_VERSION
EOF

if [[ "$INCLUDE_PAT" = "true" ]]; then
  PAT_FILE="$REPO_ROOT/docker/zitadel-machinekey/$PROJECT/pat.txt"
  [[ -f "$PAT_FILE" ]] || { echo "ERROR: --include-pat given but $PAT_FILE does not exist" >&2; exit 1; }
  cp "$PAT_FILE" "$STAGE/pat.txt"
fi

step "writing the archive" "Check available space and permissions on $OUTPUT."
mkdir -p "$OUTPUT"
ARCHIVE_NAME="${PROJECT}-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
OUT_FILE="$OUTPUT/$ARCHIVE_NAME"
tar -czf "$OUT_FILE" -C "$STAGE" .
chmod 600 "$OUT_FILE"

echo ""
echo "Backup written: $OUT_FILE"
du -h "$OUT_FILE"
