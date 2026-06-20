#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") [-h|--help] [--base-url URL] [-- <jest options>]

Run the smoke test suite.

Without --base-url: starts all services via Docker Compose with the 'auth'
profile (including Keycloak), waits for each to be healthy, runs
'npm run test:smoke', then tears down all containers on exit.

With --base-url URL: skips Docker entirely and tests the deployment at the
given URL (sets LCP_SERVER_URL). For lcp-agent or Keycloak at a different
URL, also set LCP_AGENT_URL and KEYCLOAK_URL in the environment before
invoking this script.

Smoke tests verify end-to-end health across the full stack: lcp-server,
lcp-agent, PostgreSQL, MinIO, Redis, and Keycloak. The lcp-server /health
endpoint must return 200 (which requires all its dependencies — including
the OIDC provider — to be reachable).

Keycloak can take up to 5 minutes to start on first boot; this script
waits up to 300 seconds before timing out.

Any extra arguments after -- are passed through to Jest, for example:
  $(basename "$0") -- --testNamePattern="keycloak"

Prerequisites (local mode):
  - Docker and Docker Compose
  - .env.testing present in the repo root (see .env.example)
  - lcp-server and lcp-agent images are rebuilt automatically before each run

Options:
  --base-url URL  Test against a running deployment at URL (skips Docker)
  -h, --help      Show this help message and exit
EOF
}

BASE_URL=""
PASSTHROUGH=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url) BASE_URL="$2"; shift 2 ;;
    --) shift; PASSTHROUGH+=("$@"); break ;;
    -h|--help) usage; exit 0 ;;
    *) PASSTHROUGH+=("$1"); shift ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -n "$BASE_URL" ]]; then
  # Remote mode: test against the provided URL, no Docker needed.
  # LCP_AGENT_URL and KEYCLOAK_URL fall back to localhost defaults in the spec
  # unless the caller exports them explicitly.
  export LCP_SERVER_URL="$BASE_URL"
  npm --prefix "$REPO_ROOT" run test:smoke -- ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}
  exit 0
fi

# Local mode: validate .env.testing, build, start, wait, test, tear down.
ENV_FILE="$REPO_ROOT/.env.testing"
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found." >&2
  exit 1
fi

set -a; source "$ENV_FILE"; set +a

DC="docker compose -p lcp-smoke --profile auth --env-file $ENV_FILE"

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

npm --prefix "$REPO_ROOT" run test:smoke -- ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}

$DC down
