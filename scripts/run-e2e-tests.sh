#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") [-h|--help] [-- <jest options>]

Run the end-to-end test suite against a live NestJS application.

PostgreSQL, Redis, and MinIO are started automatically as ephemeral Docker
containers by Jest's global setup (test/e2e/global-setup.ts) and torn down by
its global teardown, so no manual Docker orchestration is needed here.
Connection details are provisioned on random host ports, so this doesn't
collide on ports with a dev stack — but a running lcp-* stack still competes
for the same Docker daemon/CPU, so one must not already be running (checked
at startup).

No Zitadel required — auth is mocked (jwks-rsa). Mirrors the 'e2e-test' CI job.

Any extra arguments are passed through to Jest, for example:
  $(basename "$0") -- --testNamePattern="company"

Prerequisites:
  - Docker and Docker Compose
  - .env.testing present in the repo root (see .env.example)
  - No lcp-* containers already running (checked at startup)

Options:
  -h, --help    Show this help message and exit
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/check-no-lcp-running.sh
source "$SCRIPT_DIR/lib/check-no-lcp-running.sh"

PASSTHROUGH=()
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    *) PASSTHROUGH+=("$arg") ;;
  esac
done

check_no_lcp_containers_running || exit 1

npm run test:e2e -- ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}
