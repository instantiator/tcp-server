#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") [-h|--help] [--base-url URL] [-- <jest options>]

Run the API endpoint test suite.

Without --base-url: starts all services via Docker Compose with the 'auth'
profile (including Keycloak), waits for each to be healthy, runs
'npm run test:api', then tears down all containers on exit. Volumes are
removed on both start and exit to ensure a clean database on every run.

With --base-url URL: skips Docker entirely and runs 'npm run test:api'
against the deployment at that URL. Use the options below to supply the
URLs and credentials for that deployment.

API tests verify requests and responses through the lcp-server API with a
real Keycloak-issued JWT.

Keycloak can take up to 5 minutes to start on first boot; this script
waits up to 300 seconds before timing out.

Any extra arguments after -- are passed through to Jest, for example:
  $(basename "$0") -- --testNamePattern="company"

Prerequisites (local mode):
  - Docker and Docker Compose
  - .env.testing present in the repo root (see .env.example)
  - lcp-server and lcp-agent images are rebuilt automatically before each run

Options:
  --base-url URL            Test against a running deployment at URL (skips Docker)
  --agent-url URL           lcp-agent URL for remote mode (default: http://localhost:3001)
  --keycloak-url URL        Keycloak base URL for token exchange (default: http://localhost:8080)
  --oidc-discovery-url URL  Full OIDC discovery URL for the smoke health check
                            (default: http://localhost:8080/realms/master/.well-known/openid-configuration)
  --username NAME           Test user username for remote mode (default: test)
  --password PASS           Test user password for remote mode (default: test)
  -h, --help                Show this help message and exit

Each option can also be supplied as an environment variable:
  LCP_AGENT_URL, KEYCLOAK_URL, OIDC_DISCOVERY_URL, TEST_USERNAME, TEST_PASSWORD
CLI flags take precedence over environment variables.
EOF
}

BASE_URL=""
LCP_AGENT_URL="${LCP_AGENT_URL:-}"
KEYCLOAK_URL="${KEYCLOAK_URL:-}"
OIDC_DISCOVERY_URL="${OIDC_DISCOVERY_URL:-}"
TEST_USERNAME="${TEST_USERNAME:-}"
TEST_PASSWORD="${TEST_PASSWORD:-}"
PASSTHROUGH=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)            BASE_URL="$2";            shift 2 ;;
    --agent-url)           LCP_AGENT_URL="$2";       shift 2 ;;
    --keycloak-url)        KEYCLOAK_URL="$2";        shift 2 ;;
    --oidc-discovery-url)  OIDC_DISCOVERY_URL="$2";  shift 2 ;;
    --username)            TEST_USERNAME="$2";        shift 2 ;;
    --password)            TEST_PASSWORD="$2";        shift 2 ;;
    --) shift; PASSTHROUGH+=("$@"); break ;;
    -h|--help) usage; exit 0 ;;
    *) PASSTHROUGH+=("$1"); shift ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -n "$BASE_URL" ]]; then
  # Remote mode: test against the provided URL, no Docker needed.
  export LCP_SERVER_URL="$BASE_URL"
  [[ -n "$LCP_AGENT_URL" ]]       && export LCP_AGENT_URL
  [[ -n "$KEYCLOAK_URL" ]]        && export KEYCLOAK_URL
  [[ -n "$OIDC_DISCOVERY_URL" ]]  && export OIDC_DISCOVERY_URL
  [[ -n "$TEST_USERNAME" ]]       && export TEST_USERNAME
  [[ -n "$TEST_PASSWORD" ]]       && export TEST_PASSWORD
  npm --prefix "$REPO_ROOT" run test:api -- ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}
  exit 0
fi

# Local mode: validate .env.testing, build, start, wait, test, tear down.
ENV_FILE="$REPO_ROOT/.env.testing"
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found." >&2
  exit 1
fi

set -a; source "$ENV_FILE"; set +a

DC="docker compose -p lcp-api --profile auth --env-file $ENV_FILE"

wait_for() {
  local name="$1" cmd="$2" max="${3:-120}"
  local waited=0
  echo "Waiting for $name..."
  until eval "$cmd" 2>/dev/null; do
    sleep 3; waited=$((waited + 3))
    if [ "$waited" -ge "$max" ]; then
      echo "ERROR: Timed out waiting for $name after ${max}s" >&2
      $DC logs --tail=20
      exit 1
    fi
  done
  echo "$name ready."
}

trap 'rc=$?; $DC down; exit $rc' EXIT
$DC down -v
$DC build lcp-server lcp-agent
$DC up -d

# Keycloak starts slowly — allow up to 5 minutes.
# Use the master realm OIDC discovery URL: always present on a fresh Keycloak,
# served on port 8080 (unlike /health/ready which moved to port 9000 in KC 24+).
wait_for keycloak "curl -sf http://localhost:8080/realms/master/.well-known/openid-configuration" 300

# lcp-server health now includes an OIDC check, so this confirms the full stack.
wait_for lcp-server "curl -sf http://localhost:3000/health"
wait_for lcp-agent "curl -sf http://localhost:3001/health"

# Configure Keycloak: create lcp realm, lcp-server client, and a test user.
# Mirrors the setup done by dev/start-dev.sh. Safe to re-run.
kc() { $DC exec -T keycloak /opt/keycloak/bin/kcadm.sh "$@"; }

ADMIN_PASS="${KEYCLOAK_ADMIN_PASSWORD:-admin}"
CLIENT_ID="${OIDC_CLIENT_ID:-lcp-server}"
CLIENT_SECRET="${OIDC_CLIENT_SECRET:-test-stub}"
TEST_USERNAME_VAL="${TEST_USERNAME:-test}"
TEST_PASSWORD_VAL="${TEST_PASSWORD:-test}"

echo ""
echo "Configuring Keycloak..."
kc config credentials --server http://localhost:8080 --realm master --user admin --password "$ADMIN_PASS"

if ! kc get realms/lcp > /dev/null 2>&1; then
  kc create realms -s realm=lcp -s enabled=true
  echo "  Created realm: lcp"
else
  echo "  Realm lcp: already exists"
fi

CLIENT_INFO=$(kc get clients -r lcp -q "clientId=$CLIENT_ID" 2>&1 || true)
if echo "$CLIENT_INFO" | grep -q '"id"'; then
  echo "  Client $CLIENT_ID: already exists"
else
  kc create clients -r lcp \
    -s "clientId=$CLIENT_ID" \
    -s "secret=$CLIENT_SECRET" \
    -s enabled=true \
    -s clientAuthenticatorType=client-secret \
    -s protocol=openid-connect \
    -s directAccessGrantsEnabled=true \
    -s 'redirectUris=["http://localhost:3000/*"]'
  echo "  Created client: $CLIENT_ID"
fi

USER_INFO=$(kc get users -r lcp -q "username=$TEST_USERNAME_VAL" 2>&1 || true)
if echo "$USER_INFO" | grep -q '"id"'; then
  echo "  User $TEST_USERNAME_VAL: already exists"
else
  kc create users -r lcp \
    -s "username=$TEST_USERNAME_VAL" \
    -s "email=${TEST_USERNAME_VAL}@lcp.local" \
    -s emailVerified=true \
    -s firstName=Test \
    -s lastName=User \
    -s enabled=true
  kc set-password -r lcp --username "$TEST_USERNAME_VAL" \
    --new-password "$TEST_PASSWORD_VAL"
  echo "  Created user: $TEST_USERNAME_VAL"
fi

npm --prefix "$REPO_ROOT" run test:api -- ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}

$DC down
