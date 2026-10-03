#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") [-h|--help] [-- <jest options>]

Run the integration test suite against live infrastructure services.

PostgreSQL, Redis, MinIO, and the stub-llm service are started automatically
as ephemeral Docker containers by Jest's global setup
(apps/backend/test/integration/global-setup.ts) and torn down by its global teardown, so no
manual Docker orchestration is needed here. Connection details are provisioned
on random host ports, so this doesn't collide on ports with a dev stack — but
a running tcp-* stack still competes for the same Docker daemon/CPU, so one
must not already be running (checked at startup).

Integration tests verify that the application can connect to and use each
service correctly (database queries, Redis pub/sub, MinIO bucket operations).
Mirrors the 'integration-test' CI job.

Any extra arguments are passed through to Jest, for example:
  $(basename "$0") -- --testNamePattern="redis"

A rare hang on exit (every test passed, then "Jest did not exit") is caught by
a watchdog: if Jest is still running after INTEGRATION_HANG_SECONDS (default
600; a normal run takes 2-3 minutes), it writes a Node diagnostic report
listing what was still open to test-results/integration-diagnostics/, then
stops Jest so the run fails rather than hangs.

Prerequisites:
  - Docker and Docker Compose
  - .env.testing present in the repo root (see .env.example)
  - No tcp-* containers already running (checked at startup)

Options:
  -h, --help    Show this help message and exit
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib/check-no-tcp-running.sh
source "$SCRIPT_DIR/lib/check-no-tcp-running.sh"

# Derive host-facing URLs (notably TCP_SERVER_URL, which tcp-agent's config
# schema requires at boot) from .env.testing and export them so Jest inherits
# them. DATABASE_URL/REDIS_URL/MINIO_ENDPOINT are re-derived per-run from the
# testcontainers' random host ports and overwrite these placeholders.
if [[ -f "$REPO_ROOT/.env.testing" ]]; then
  set -a
  # shellcheck disable=SC1091 # env file, not shell source
  source "$REPO_ROOT/.env.testing"
  set +a
fi
# shellcheck source=scripts/lib/derive-urls.sh
# shellcheck disable=SC1091 # source path resolved at runtime
source "$SCRIPT_DIR/lib/derive-urls.sh"
derive_host_urls

PASSTHROUGH=()
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    *) PASSTHROUGH+=("$arg") ;;
  esac
done

check_no_tcp_containers_running || exit 1

# The integration tier sometimes hangs after every test has passed, with
# nothing to say why, and `--detectOpenHandles` changes the timing enough that
# it doesn't reproduce under it. So each run can be asked for a Node diagnostic
# report (`SIGUSR2`), which lists the live libuv handles (sockets, timers,
# threads) without changing anything. The watchdog below asks only if Jest
# outlives the limit, then stops it. See docs/outstanding-issues.md.
HANG_SECONDS="${INTEGRATION_HANG_SECONDS:-600}"
REPORT_DIR="$REPO_ROOT/test-results/integration-diagnostics"
mkdir -p "$REPORT_DIR"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--report-on-signal --report-signal=SIGUSR2 --report-directory=$REPORT_DIR"

# Jest itself, not npm or the `sh -c` npm runs it under: only the node process
# running jest holds the handles worth reporting.
JEST_PATTERN='node .*jest --config test/jest-integration.json'

watch_for_hang() {
  local deadline jest_pid
  deadline=$(( $(date +%s) + HANG_SECONDS ))
  while (( $(date +%s) < deadline )); do
    sleep 5
  done
  jest_pid="$(pgrep -f "$JEST_PATTERN" | head -n 1 || true)"
  [[ -n "$jest_pid" ]] || return 0
  echo "Jest is still running after ${HANG_SECONDS}s: writing a diagnostic report to $REPORT_DIR and stopping it." >&2
  kill -USR2 "$jest_pid" 2>/dev/null || true
  # Long enough for the report to be written; it is synchronous and small.
  sleep 3
  kill "$jest_pid" 2>/dev/null || true
}

# npm stays in the foreground so Ctrl-C still reaches it; the watchdog is the
# background job, killed as soon as npm returns (or the script is interrupted).
watch_for_hang &
WATCHDOG_PID=$!
trap 'kill "$WATCHDOG_PID" 2>/dev/null || true' EXIT

status=0
npm run test:integration -- ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"} || status=$?
exit "$status"
