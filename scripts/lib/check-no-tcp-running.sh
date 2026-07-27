#!/usr/bin/env bash
# Shared pre-flight guard, sourced (not executed) by test-runner scripts that
# manage their own ephemeral Docker infrastructure (testcontainers, random
# host ports). A concurrently running tcp-* stack (e.g. tcp-dev) doesn't
# collide on those ports, but it competes for the same Docker daemon and CPU,
# which has been observed to slow ephemeral container startup enough to time
# out the suite — so this fails fast instead of leaving that to guesswork.
#
# Usage:
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   # shellcheck source=scripts/lib/check-no-tcp-running.sh
#   source "$SCRIPT_DIR/lib/check-no-tcp-running.sh"
#   check_no_tcp_containers_running || exit 1

check_no_tcp_containers_running() {
  local conflicting
  conflicting=$(docker ps --format '{{.Names}}' 2>/dev/null | grep '^tcp-' || true)
  if [ -n "$conflicting" ]; then
    echo "ERROR: TCP containers are already running:" >&2
    # shellcheck disable=SC2001 # sed reads better than ${var//} for multi-line prefixing
    echo "$conflicting" | sed 's/^/  /' >&2
    echo "" >&2
    echo "A running tcp-* stack competes for Docker/CPU with this suite's own" >&2
    echo "ephemeral test containers and can cause slow starts or timeouts, even" >&2
    echo "without a port collision." >&2
    echo "Stop it first (e.g. 'docker compose -p tcp-dev down') and retry." >&2
    return 1
  fi
}
