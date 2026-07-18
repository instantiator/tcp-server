#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") [-h|--help] [--base-url URL] [-- <jest options>]

Run the API endpoint test suite against a running LCP deployment.

Defaults to http://localhost:3000 when --base-url is not given, which is
where start-deployment.sh starts the stack. Start services first:

  ./scripts/start-deployment.sh --project lcp-api --env-file .env.testing
  $(basename "$0")                           # targets localhost:3000
  docker compose -p lcp-api --profile auth down -v

API tests verify authenticated HTTP requests against lcp-server using a real
Zitadel-issued JWT.

Any extra arguments after -- are passed through to Jest, for example:
  $(basename "$0") -- --testNamePattern="company"

Options:
  --base-url URL            lcp-server base URL (default: http://localhost:3000)
  --agent-url URL           lcp-agent URL (default: http://localhost:3001)
  --oidc-discovery-url URL  Full OIDC discovery URL
                            (default: http://localhost:8080/.well-known/openid-configuration)
  --client-id ID            Machine test user client ID (client_credentials)
  --client-secret SECRET    Machine test user client secret
  -h, --help                Show this help message and exit

Each option can also be supplied as an environment variable:
  LCP_SERVER_URL, LCP_AGENT_URL, OIDC_DISCOVERY_URL,
  TEST_CLIENT_ID, TEST_CLIENT_SECRET
CLI flags take precedence over environment variables.
EOF
}

BASE_URL="${LCP_SERVER_URL:-http://localhost:3000}"
LCP_AGENT_URL="${LCP_AGENT_URL:-}"
OIDC_DISCOVERY_URL="${OIDC_DISCOVERY_URL:-}"
TEST_CLIENT_ID="${TEST_CLIENT_ID:-}"
TEST_CLIENT_SECRET="${TEST_CLIENT_SECRET:-}"
PASSTHROUGH=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)            BASE_URL="$2";            shift 2 ;;
    --agent-url)           LCP_AGENT_URL="$2";       shift 2 ;;
    --oidc-discovery-url)  OIDC_DISCOVERY_URL="$2";  shift 2 ;;
    --client-id)           TEST_CLIENT_ID="$2";      shift 2 ;;
    --client-secret)       TEST_CLIENT_SECRET="$2";  shift 2 ;;
    --) shift; PASSTHROUGH+=("$@"); break ;;
    -h|--help) usage; exit 0 ;;
    *) PASSTHROUGH+=("$1"); shift ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export LCP_SERVER_URL="$BASE_URL"
[[ -n "$LCP_AGENT_URL" ]]       && export LCP_AGENT_URL
[[ -n "$OIDC_DISCOVERY_URL" ]]  && export OIDC_DISCOVERY_URL
[[ -n "$TEST_CLIENT_ID" ]]      && export TEST_CLIENT_ID
[[ -n "$TEST_CLIENT_SECRET" ]]  && export TEST_CLIENT_SECRET

npm --prefix "$REPO_ROOT" run test:api -- ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}
