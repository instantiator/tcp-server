#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") [-h|--help] [-- <jest options>]

Run the end-to-end test suite against a live NestJS application.

PostgreSQL, Redis, and MinIO are started automatically as ephemeral Docker
containers by Jest's global setup (test/e2e/global-setup.ts) and torn down by
its global teardown, so no manual Docker orchestration is needed here.
Connection details are provisioned on random host ports, so this can run
alongside a dev stack without conflict.

No Keycloak required — auth is mocked (jwks-rsa). Mirrors the 'e2e-test' CI job.

Any extra arguments are passed through to Jest, for example:
  $(basename "$0") -- --testNamePattern="company"

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

npm run test:e2e -- ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}
