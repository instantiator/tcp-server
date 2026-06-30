#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") [-h|--help] [--base-url URL] [-- <jest options>]

Run the smoke test suite against a running LCP deployment.

Defaults to http://localhost:3000 when --base-url is not given, which is
where start-deployment.sh starts the stack. Start services first:

  ./scripts/start-deployment.sh --project lcp-smoke --env-file .env.testing
  $(basename "$0")                            # targets localhost:3000
  docker compose -p lcp-smoke --profile auth down -v

Smoke tests verify end-to-end health across the full stack: lcp-server,
lcp-agent, all three MCP services, PostgreSQL, MinIO, Redis, and Keycloak.

Any extra arguments after -- are passed through to Jest, for example:
  $(basename "$0") -- --testNamePattern="keycloak"

Options:
  --base-url URL            lcp-server base URL (default: http://localhost:3000)
  --agent-url URL           lcp-agent URL (default: http://localhost:3001)
  --oidc-discovery-url URL  Full OIDC discovery URL
                            (default: http://localhost:8080/realms/master/.well-known/openid-configuration)
  --username NAME           Test user username (default: test)
  --password PASS           Test user password (default: test)
  -h, --help                Show this help message and exit

Each option can also be supplied as an environment variable:
  LCP_SERVER_URL, LCP_AGENT_URL, OIDC_DISCOVERY_URL, TEST_USERNAME, TEST_PASSWORD
CLI flags take precedence over environment variables.
EOF
}

BASE_URL="${LCP_SERVER_URL:-http://localhost:3000}"
LCP_AGENT_URL="${LCP_AGENT_URL:-}"
OIDC_DISCOVERY_URL="${OIDC_DISCOVERY_URL:-}"
TEST_USERNAME="${TEST_USERNAME:-}"
TEST_PASSWORD="${TEST_PASSWORD:-}"
PASSTHROUGH=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)            BASE_URL="$2";            shift 2 ;;
    --agent-url)           LCP_AGENT_URL="$2";       shift 2 ;;
    --oidc-discovery-url)  OIDC_DISCOVERY_URL="$2";  shift 2 ;;
    --username)            TEST_USERNAME="$2";        shift 2 ;;
    --password)            TEST_PASSWORD="$2";        shift 2 ;;
    --) shift; PASSTHROUGH+=("$@"); break ;;
    -h|--help) usage; exit 0 ;;
    *) PASSTHROUGH+=("$1"); shift ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export LCP_SERVER_URL="$BASE_URL"
[[ -n "$LCP_AGENT_URL" ]]       && export LCP_AGENT_URL
[[ -n "$OIDC_DISCOVERY_URL" ]]  && export OIDC_DISCOVERY_URL
[[ -n "$TEST_USERNAME" ]]       && export TEST_USERNAME
[[ -n "$TEST_PASSWORD" ]]       && export TEST_PASSWORD

npm --prefix "$REPO_ROOT" run test:smoke -- ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}
