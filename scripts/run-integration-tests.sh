#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") [-h|--help] [-- <jest options>]

Run the integration test suite against live infrastructure services.

PostgreSQL, Redis, MinIO, and the stub-llm service are started automatically
as ephemeral Docker containers by Jest's global setup
(test/integration/global-setup.ts) and torn down by its global teardown, so no
manual Docker orchestration is needed here. Connection details are provisioned
on random host ports, so this can run alongside a dev stack without conflict.

Integration tests verify that the application can connect to and use each
service correctly (database queries, Redis pub/sub, MinIO bucket operations).
Mirrors the 'integration-test' CI job.

Any extra arguments are passed through to Jest, for example:
  $(basename "$0") -- --testNamePattern="redis"

Prerequisites:
  - Docker and Docker Compose
  - .env.testing present in the repo root (see .env.example)

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

npm run test:integration -- ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}
