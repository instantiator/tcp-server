#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") [-h|--help] [-- <jest options>]

Run the unit test suite.

No external services required — tests use an in-memory SQLite database.
Mirrors the 'unit-test' CI job.

Any extra arguments are passed through to Jest, for example:
  $(basename "$0") -- --testNamePattern="company"
  $(basename "$0") -- --testPathPattern="api"

Options:
  -h, --help    Show this help message and exit
EOF
}

PASSTHROUGH=()
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    *) PASSTHROUGH+=("$arg") ;;
  esac
done

npm test -- ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}

# tcp-stub-llm isn't an npm workspace (own TypeScript major/eslint config — see
# ADR-022), so `npm test --workspaces` above never reaches it. Passthrough args
# are Jest-specific and don't apply to its node:test runner, so it gets its own
# unconditional invocation rather than sharing the line above.
npm --prefix apps/tcp-stub-llm test
