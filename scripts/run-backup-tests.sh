#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") --project <name> --env-file <path> [-h|--help]

Round-trip test for scripts/backup.sh and scripts/restore.sh: starts a stack,
seeds a company and a storage object, backs it up, destroys the stack, restores
it, and checks the data (and the API) came back byte-for-byte. Also checks
that a backup newer than this checkout is refused.

This is a test tier, not a backup tool — see scripts/backup.sh and
scripts/restore.sh for actual operator use, and docs/backup-and-restore.md.

The project is torn down (containers and volumes) on exit, success or
failure.

Options:
  --project <name>    Docker Compose project name (required)
  --env-file <path>   Env file to start the stack with (required)
  -h, --help          Show this help message and exit
EOF
}

PROJECT=""
ENV_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      [[ -n "${2:-}" ]] || { echo "ERROR: --project requires a value" >&2; exit 1; }
      PROJECT="$2"; shift 2 ;;
    --env-file)
      [[ -n "${2:-}" ]] || { echo "ERROR: --env-file requires a path" >&2; exit 1; }
      ENV_FILE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

[[ -n "$PROJECT" ]]  || { echo "ERROR: --project is required" >&2; usage >&2; exit 1; }
[[ -n "$ENV_FILE" ]] || { echo "ERROR: --env-file is required" >&2; usage >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "ERROR: env file not found: $ENV_FILE" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/lib/errors.sh
# shellcheck disable=SC1091 # source path resolved at runtime
source "$REPO_ROOT/scripts/lib/errors.sh"
enable_error_report
# shellcheck source=scripts/lib/machine-token.sh
# shellcheck disable=SC1091 # source path resolved at runtime
source "$REPO_ROOT/scripts/lib/machine-token.sh"

# Load the stack's env the same way restore.sh does: base file, then its
# gitignored ".local" override (last value wins).
set -a
# shellcheck disable=SC1090 # env file path is only known at runtime
source "$ENV_FILE"
set +a
LOCAL_ENV_FILE="$ENV_FILE.local"
touch "$LOCAL_ENV_FILE"
set -a
# shellcheck disable=SC1090 # env file path is only known at runtime
source "$LOCAL_ENV_FILE"
set +a

DB_USER="${DB_USER:-tcp}"
DB_NAME="${DB_NAME:-tcp}"
API="http://localhost:${EXPOSE_PORT_API:-3000}"
DC="docker compose -p $PROJECT -f $REPO_ROOT/docker-compose.yml --profile auth --env-file $ENV_FILE --env-file $LOCAL_ENV_FILE"

WORK="$(mktemp -d)"
cleanup() {
  $DC down -v >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

PASS_COUNT=0

# Prints a PASS line and counts it.
check_pass() {
  echo "PASS: $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

# Prints a FAIL line (with an optional detail) and exits non-zero — every
# later check depends on the stack being in the state the failed one expected.
check_fail() {
  echo "FAIL: $1" >&2
  if [[ -n "${2:-}" ]]; then
    local line
    while IFS= read -r line; do
      echo "  $line" >&2
    done <<< "$2"
  fi
  exit 1
}

# curl, writing the response body to $1 and leaving the HTTP status code on
# stdout. Every HTTP assertion below reads both.
http_status() {
  local outfile="$1"
  shift
  curl -s -o "$outfile" -w '%{http_code}' "$@"
}

# Row count of every table in the tcp database, plus the object list, as one
# sorted, diffable text block: `table=count` lines, then `<size> <key>`
# lines. Table names are read from information_schema rather than assumed, so
# a migration that adds or drops a table is covered without touching this
# script.
snapshot() {
  local tables table count
  tables="$($DC exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -tAc \
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name")"
  while IFS= read -r table; do
    [[ -n "$table" ]] || continue
    count="$($DC exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT count(*) FROM \"$table\"")"
    echo "$table=$count"
  done <<< "$tables" | sort

  # shellcheck disable=SC2016 # single-quoted deliberately: $MINIO_ROOT_USER/
  # $MINIO_ROOT_PASSWORD must expand inside the container's shell, not this one.
  $DC exec -T minio sh -c 'mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc ls -r local' \
    | awk '{ size = $4; key = ""; for (i = 6; i <= NF; i++) { key = key (key == "" ? "" : " ") $i } print size " " key }' \
    | sort
}

step "starting the stack" "start-deployment.sh's own output is above."
"$REPO_ROOT/scripts/start-deployment.sh" --project "$PROJECT" --env-file "$ENV_FILE"
# start-deployment.sh's Zitadel bootstrap rewrites TEST_CLIENT_ID/SECRET into
# the .local override on every run — re-source to pick those up.
set -a
# shellcheck disable=SC1090 # env file path is only known at runtime
source "$LOCAL_ENV_FILE"
set +a
check_pass "stack started"

step "obtaining a machine token" "Zitadel bootstrap's own output is above."
TOKEN="$(get_machine_token "$ENV_FILE")"
[[ -n "$TOKEN" && "$TOKEN" != "null" ]] || check_fail "obtained a machine token" "get_machine_token returned nothing"
check_pass "obtained a machine token"

step "seeding a company" "tcp-server's own response is above."
COMPANY_STATUS="$(http_status "$WORK/company.json" -X POST "$API/api/company" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"slug":"backup-roundtrip","name":"Backup roundtrip","description":"backup round trip"}')"
[[ "$COMPANY_STATUS" == "201" ]] || check_fail "seed company created (201)" "got $COMPANY_STATUS: $(cat "$WORK/company.json")"
check_pass "seed company created (201)"

step "seeding a storage object" "tcp-server's own response is above."
SEED_CONTENT="backup-roundtrip-$$-$(date +%s)"
printf '%s' "$SEED_CONTENT" > "$WORK/seed.txt"
UPLOAD_STATUS="$(http_status "$WORK/upload.json" -X POST "$API/api/storage?path=backup-roundtrip/seed.txt" \
  -H "Authorization: Bearer $TOKEN" -F "file=@$WORK/seed.txt")"
[[ "$UPLOAD_STATUS" == "201" ]] || check_fail "seed object uploaded (201)" "got $UPLOAD_STATUS: $(cat "$WORK/upload.json")"
check_pass "seed object uploaded (201)"

step "taking the first snapshot" "psql/mc's own output is above."
snapshot > "$WORK/snapshot-before.txt"
check_pass "took the pre-backup snapshot"

step "backing up the stack" "backup.sh's own output is above."
"$REPO_ROOT/scripts/backup.sh" --project "$PROJECT" --env-file "$ENV_FILE" --include-pat --output "$WORK"
ARCHIVE="$(find "$WORK" -maxdepth 1 -name "${PROJECT}-*.tar.gz" -print -quit)"
[[ -n "$ARCHIVE" ]] || check_fail "backup archive written" "no ${PROJECT}-*.tar.gz under $WORK"
check_pass "backup archive written: $(basename "$ARCHIVE")"

step "destroying the stack" "Docker's own output is above."
$DC down -v
check_pass "stack destroyed"

step "restoring the stack" "restore.sh's own output is above."
"$REPO_ROOT/scripts/restore.sh" --project "$PROJECT" --env-file "$ENV_FILE" --archive "$ARCHIVE" --yes
set -a
# shellcheck disable=SC1090 # env file path is only known at runtime
source "$LOCAL_ENV_FILE"
set +a
check_pass "stack restored"

step "taking the second snapshot" "psql/mc's own output is above."
snapshot > "$WORK/snapshot-after.txt"
check_pass "took the post-restore snapshot"

step "comparing snapshots" "The diff is above."
BEFORE="$WORK/snapshot-before.txt"
AFTER="$WORK/snapshot-after.txt"
if ! diff -u "$BEFORE" "$AFTER" > "$WORK/snapshot.diff"; then
  check_fail "restored snapshot matches the backup" "$(cat "$WORK/snapshot.diff")"
fi
check_pass "restored snapshot matches the backup"

step "obtaining a post-restore token" "Zitadel bootstrap's own output is above."
TOKEN2="$(get_machine_token "$ENV_FILE")"
[[ -n "$TOKEN2" && "$TOKEN2" != "null" ]] || check_fail "obtained a post-restore token" "get_machine_token returned nothing"
check_pass "obtained a post-restore token"

step "checking the restored company" "tcp-server's own response is above."
GET_COMPANY_STATUS="$(http_status "$WORK/get-company.json" "$API/api/company/backup-roundtrip" \
  -H "Authorization: Bearer $TOKEN2")"
[[ "$GET_COMPANY_STATUS" == "200" ]] || check_fail "restored company reachable (200)" "got $GET_COMPANY_STATUS: $(cat "$WORK/get-company.json")"
check_pass "restored company reachable (200)"

step "checking the restored storage object" "tcp-server's own response is above."
GET_OBJECT_STATUS="$(http_status "$WORK/get-object.txt" "$API/api/storage?path=backup-roundtrip/seed.txt" \
  -H "Authorization: Bearer $TOKEN2")"
[[ "$GET_OBJECT_STATUS" == "200" ]] || check_fail "restored object reachable (200)" "got $GET_OBJECT_STATUS"
RESTORED_CONTENT="$(cat "$WORK/get-object.txt")"
[[ "$RESTORED_CONTENT" == "$SEED_CONTENT" ]] || check_fail "restored object content matches" "expected '$SEED_CONTENT', got '$RESTORED_CONTENT'"
check_pass "restored object content matches"

step "checking a too-new backup is refused" "restore.sh's own output is above, if any."
TAMPER_DIR="$WORK/tamper"
mkdir -p "$TAMPER_DIR"
tar -xzf "$ARCHIVE" -C "$TAMPER_DIR"
sed 's/^LATEST_MIGRATION=.*/LATEST_MIGRATION=NoSuchMigration9999999999999/' \
  "$TAMPER_DIR/manifest.env" > "$TAMPER_DIR/manifest.env.tmp"
mv "$TAMPER_DIR/manifest.env.tmp" "$TAMPER_DIR/manifest.env"
TAMPERED_ARCHIVE="$WORK/tampered.tar.gz"
tar -czf "$TAMPERED_ARCHIVE" -C "$TAMPER_DIR" .
RESTORE_RC=0
RESTORE_OUTPUT="$("$REPO_ROOT/scripts/restore.sh" --project "$PROJECT" --env-file "$ENV_FILE" --archive "$TAMPERED_ARCHIVE" --yes 2>&1)" || RESTORE_RC=$?
[[ "$RESTORE_RC" -ne 0 ]] || check_fail "tampered archive refused (non-zero exit)" "restore.sh exited 0"
grep -q "is not in this checkout" <<< "$RESTORE_OUTPUT" || check_fail "tampered archive refused (right reason)" "$RESTORE_OUTPUT"
check_pass "tampered archive refused"

echo ""
echo "All $PASS_COUNT checks passed."
