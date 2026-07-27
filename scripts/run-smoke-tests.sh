#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") [-h|--help] [--base-url URL] [-- <jest options>]

Run the smoke test suite against a running LCP deployment.

Defaults to http://localhost:3000 when --base-url is not given, which is
where start-deployment.sh starts the stack. Start services first:

  ./scripts/start-deployment.sh --project tcp-smoke --env-file .env.testing
  $(basename "$0")                            # targets localhost:3000
  docker compose -p tcp-smoke --profile auth down -v

Smoke tests verify end-to-end health across the full stack: tcp-server,
tcp-agent, all three MCP services, PostgreSQL, MinIO, Redis, and Zitadel.

Any extra arguments after -- are passed through to Jest, for example:
  $(basename "$0") -- --testNamePattern="oidc"

Options:
  --base-url URL            tcp-server base URL (default: http://localhost:3000)
  --agent-url URL           tcp-agent URL (default: http://localhost:3001)
  --oidc-discovery-url URL  Full OIDC discovery URL
                            (default: http://localhost:8080/.well-known/openid-configuration)
  -h, --help                Show this help message and exit

Each option can also be supplied as an environment variable:
  LCP_SERVER_URL, LCP_AGENT_URL, OIDC_DISCOVERY_URL
CLI flags take precedence over environment variables.
EOF
}

BASE_URL="${LCP_SERVER_URL:-http://localhost:3000}"
LCP_AGENT_URL="${LCP_AGENT_URL:-}"
OIDC_DISCOVERY_URL="${OIDC_DISCOVERY_URL:-}"
PASSTHROUGH=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)            BASE_URL="$2";            shift 2 ;;
    --agent-url)           LCP_AGENT_URL="$2";       shift 2 ;;
    --oidc-discovery-url)  OIDC_DISCOVERY_URL="$2";  shift 2 ;;
    --) shift; PASSTHROUGH+=("$@"); break ;;
    -h|--help) usage; exit 0 ;;
    *) PASSTHROUGH+=("$1"); shift ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export LCP_SERVER_URL="$BASE_URL"
[[ -n "$LCP_AGENT_URL" ]]       && export LCP_AGENT_URL
[[ -n "$OIDC_DISCOVERY_URL" ]]  && export OIDC_DISCOVERY_URL

npm --prefix "$REPO_ROOT" run test:smoke -- ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}
