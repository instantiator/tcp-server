#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") [-h|--help] [-- <jest options>]

Run the unit test suite.

No external services required — tests use an in-memory SQLite database.
Mirrors the 'unit-test' CI job.

Any extra arguments are passed through to both the backend's Jest and the
frontend's Vitest, so use options they share, for example:
  $(basename "$0") -- --testNamePattern="company"
  $(basename "$0") -- api          # only test files whose path matches "api"

Options:
  -h, --help    Show this help message and exit
EOF
}

PASSTHROUGH=()
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --) ;; # the separator itself, not an argument
    *) PASSTHROUGH+=("$arg") ;;
  esac
done

npm test -- ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}

# tcp-stub-llm isn't an npm workspace (own TypeScript major/eslint config — see
# ADR-022), so `npm test --workspaces` above never reaches it. Passthrough args
# are Jest-specific and don't apply to its node:test runner, so it gets its own
# unconditional invocation rather than sharing the line above.
npm --prefix apps/tcp-stub-llm test

# Shell helpers with logic worth pinning down.
"$(dirname "$0")/lib/errors.test.sh"
