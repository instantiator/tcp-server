#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

usage() {
  cat <<EOF
Usage: $(basename "$0") [-h|--help] [-e|--env <path>] [--rebuild] [--test-username <name>] [--test-password <pass>]

Start a full local development environment and configure it for first-time use.

Starts all services via Docker Compose (including Keycloak), waits for each
to be healthy, then creates the Keycloak lcp realm, lcp-server client, and a
test user. Safe to re-run — existing resources are left untouched.

Environment file precedence (first match wins):
  1. --env <path>      if provided
  2. .env              if present in the repo root
  3. .env.testing      fallback (always present, safe test credentials)

Options:
  -e, --env <path>          Environment file to use
  --rebuild                 Force a Docker image rebuild (passes --build to docker compose up)
  --test-username <name>    Keycloak test user username (default: test)
  --test-password <pass>    Keycloak test user password (default: test)
  -h, --help                Show this help message and exit
EOF
}

# Argument parsing

ENV_FILE=""
REBUILD=false
TEST_USERNAME="test"
TEST_PASSWORD="test"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -e|--env)
      [[ -n "${2:-}" ]] || { echo "ERROR: --env requires a path" >&2; exit 1; }
      ENV_FILE="$2"; shift 2 ;;
    --rebuild) REBUILD=true; shift ;;
    --test-username)
      [[ -n "${2:-}" ]] || { echo "ERROR: --test-username requires a value" >&2; exit 1; }
      TEST_USERNAME="$2"; shift 2 ;;
    --test-password)
      [[ -n "${2:-}" ]] || { echo "ERROR: --test-password requires a value" >&2; exit 1; }
      TEST_PASSWORD="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# Resolve env file

if [[ -z "$ENV_FILE" ]]; then
  if [[ -f "$REPO_ROOT/.env" ]]; then
    ENV_FILE="$REPO_ROOT/.env"
  else
    ENV_FILE="$REPO_ROOT/.env.testing"
  fi
fi

[[ -f "$ENV_FILE" ]] || { echo "ERROR: env file not found: $ENV_FILE" >&2; exit 1; }

echo "Using: $ENV_FILE"
set -a; source "$ENV_FILE"; set +a

# Pre-flight: verify all required variables are non-empty.
# These match the Joi required() fields in lcp-server and lcp-agent config schemas.
REQUIRED_VARS=(
  DATABASE_URL REDIS_URL
  MINIO_ENDPOINT MINIO_ACCESS_KEY MINIO_SECRET_KEY
  OIDC_ISSUER_URL OIDC_CLIENT_ID OIDC_CLIENT_SECRET
  INTERNAL_API_KEY LCP_SERVER_URL
)
missing=()
for var in "${REQUIRED_VARS[@]}"; do
  [[ -n "${!var:-}" ]] || missing+=("$var")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "" >&2
  echo "ERROR: the following required variables are missing or empty in $ENV_FILE:" >&2
  for var in "${missing[@]}"; do echo "  $var" >&2; done
  echo "" >&2
  echo "Add them to $ENV_FILE and retry. See .env.example for reference values." >&2
  echo "" >&2
  exit 1
fi

DC="docker compose -p lcp-dev --profile auth --env-file $ENV_FILE"

# Helpers

wait_for() {
  local name="$1" cmd="$2" max="${3:-120}"
  local waited=0
  echo "Waiting for $name..."
  until eval "$cmd" 2>/dev/null; do
    sleep 3; waited=$((waited + 3))
    if [[ "$waited" -ge "$max" ]]; then
      echo "ERROR: Timed out waiting for $name after ${max}s" >&2
      $DC logs --tail=20
      exit 1
    fi
  done
  echo "$name ready."
}

# Run kcadm inside the already-running keycloak container.
kc() { $DC exec -T keycloak /opt/keycloak/bin/kcadm.sh "$@"; }

# Start services

echo ""
echo "Starting services..."
if [[ "$REBUILD" = "true" ]]; then
  $DC up -d --build
else
  $DC up -d
fi

# Keycloak starts slowly on first boot — allow up to 5 minutes.
wait_for keycloak \
  "curl -sf http://localhost:8080/realms/master/.well-known/openid-configuration" 300

wait_for lcp-server "curl -sf http://localhost:3000/health"
wait_for lcp-agent  "curl -sf http://localhost:3001/health"

# Keycloak setup

ADMIN_PASS="${KEYCLOAK_ADMIN_PASSWORD:-admin}"
CLIENT_ID="${OIDC_CLIENT_ID:-lcp-server}"
CLIENT_SECRET="${OIDC_CLIENT_SECRET:-test-stub}"

echo ""
echo "Configuring Keycloak..."

kc config credentials \
  --server http://localhost:8080 \
  --realm master \
  --user admin \
  --password "$ADMIN_PASS"

# Realm
if ! kc get realms/lcp > /dev/null 2>&1; then
  kc create realms -s realm=lcp -s enabled=true
  echo "  Created realm: lcp"
else
  echo "  Realm lcp: already exists"
fi

# Client — confidential, service accounts enabled so lcp-server can call the
# Keycloak Admin API; directAccessGrantsEnabled for password-grant token testing.
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
    -s serviceAccountsEnabled=true \
    -s directAccessGrantsEnabled=true \
    -s 'redirectUris=["http://localhost:3000/*"]'
  # Grant the service account realm-admin so lcp-server can manage users via
  # the Keycloak Admin REST API.
  kc add-roles -r lcp \
    --uusername "service-account-$CLIENT_ID" \
    --cclientid realm-management \
    --rolename realm-admin
  echo "  Created client: $CLIENT_ID (service account granted realm-admin)"
fi

# Test user — capture output into a variable so the kcadm call runs outside
# the if-condition; pipelines inside if + set -euo pipefail behave differently
# on bash 3.2 (macOS system default) and can trigger set -e unexpectedly.
USER_INFO=$(kc get users -r lcp -q "username=$TEST_USERNAME" 2>&1 || true)
if echo "$USER_INFO" | grep -q '"id"'; then
  echo "  User $TEST_USERNAME: already exists"
else
  kc create users -r lcp \
    -s "username=$TEST_USERNAME" \
    -s "email=${TEST_USERNAME}@lcp.local" \
    -s emailVerified=true \
    -s firstName=Test \
    -s lastName=User \
    -s enabled=true
  kc set-password -r lcp \
    --username "$TEST_USERNAME" \
    --new-password "$TEST_PASSWORD"
  echo "  Created user: $TEST_USERNAME"
fi

# Summary

echo ""
echo "=================================================="
echo "  Development environment ready"
echo "=================================================="
echo ""
echo "Services:"
echo "  lcp-server API  →  http://localhost:3000"
echo "  lcp-agent       →  http://localhost:3001"
echo "  Keycloak admin  →  http://localhost:8080  (admin / $ADMIN_PASS)"
echo "  MinIO console   →  http://localhost:9001"
echo ""
echo "Test user (realm: lcp):"
echo "  Username:  $TEST_USERNAME"
echo "  Password:  $TEST_PASSWORD"
echo ""
echo "Get a token:"
echo "  curl -s -X POST 'http://localhost:8080/realms/lcp/protocol/openid-connect/token' \\"
echo "    -d grant_type=password \\"
echo "    -d 'client_id=$CLIENT_ID' \\"
echo "    -d 'client_secret=$CLIENT_SECRET' \\"
echo "    -d 'username=$TEST_USERNAME' \\"
echo "    -d 'password=$TEST_PASSWORD' | jq -r .access_token"
echo ""
