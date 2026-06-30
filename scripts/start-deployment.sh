#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<EOF
Usage: $(basename "$0") --project <name> --env-file <path> [--rebuild] [-h|--help]

Start the LCP Docker Compose stack and configure it for use.

Reads all configuration — including Keycloak credentials and the first test
user — from the env file. If KEYCLOAK_ADMIN_PASSWORD is set in the env file,
the Keycloak auth profile is enabled and the realm, client, and test user are
created automatically. If KEYCLOAK_ADMIN_PASSWORD is absent or empty, the
auth profile is skipped.

Safe to re-run against an already-running stack: existing Keycloak resources
are left untouched.

Options:
  --project <name>    Docker Compose project name (required)
  --env-file <path>   Path to the env file (required)
  --rebuild           Force a Docker image rebuild before starting
  -h, --help          Show this help message and exit

Keycloak setup reads from the env file:
  KEYCLOAK_ADMIN_PASSWORD   Keycloak admin password (presence enables auth profile)
  KEYCLOAK_REALM            Realm to create/configure (default: lcp)
  OIDC_CLIENT_ID            Client ID to create
  OIDC_CLIENT_SECRET        Client secret
  TEST_USERNAME             First user to create in the realm (default: test)
  TEST_PASSWORD             That user's password (default: test)
EOF
}

PROJECT=""
ENV_FILE=""
REBUILD=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      [[ -n "${2:-}" ]] || { echo "ERROR: --project requires a value" >&2; exit 1; }
      PROJECT="$2"; shift 2 ;;
    --env-file)
      [[ -n "${2:-}" ]] || { echo "ERROR: --env-file requires a path" >&2; exit 1; }
      ENV_FILE="$2"; shift 2 ;;
    --rebuild) REBUILD=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

[[ -n "$PROJECT" ]]  || { echo "ERROR: --project is required" >&2; usage >&2; exit 1; }
[[ -n "$ENV_FILE" ]] || { echo "ERROR: --env-file is required" >&2; usage >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "ERROR: env file not found: $ENV_FILE" >&2; exit 1; }

echo "Using: $ENV_FILE"
set -a; source "$ENV_FILE"; set +a

# Pre-flight: verify all required variables are non-empty.
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

# Auth profile: enabled when KEYCLOAK_ADMIN_PASSWORD is set and non-empty.
AUTH_PROFILE=""
if [[ -n "${KEYCLOAK_ADMIN_PASSWORD:-}" ]]; then
  AUTH_PROFILE="--profile auth"
fi

DC="docker compose -p $PROJECT $AUTH_PROFILE --env-file $ENV_FILE"

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

# Run kcadm inside the running keycloak container.
kc() { $DC exec -T keycloak /opt/keycloak/bin/kcadm.sh "$@"; }

# Start services

echo ""
echo "Starting services (project: $PROJECT)..."
if [[ "$REBUILD" = "true" ]]; then
  $DC up -d --build
else
  $DC up -d
fi

# Keycloak: wait up to 5 minutes on first boot.
if [[ -n "$AUTH_PROFILE" ]]; then
  wait_for keycloak \
    "curl -sf http://localhost:8080/realms/master/.well-known/openid-configuration" 300
fi

wait_for lcp-server           "curl -sf http://localhost:3000/health"
wait_for lcp-agent            "curl -sf http://localhost:3001/health"
wait_for lcp-mcp-storage      "curl -sf http://localhost:3010/health"
wait_for lcp-mcp-memory       "curl -sf http://localhost:3011/health"
wait_for lcp-mcp-interactions "curl -sf http://localhost:3012/health"

# Keycloak setup (skipped when auth profile is not active)
if [[ -n "$AUTH_PROFILE" ]]; then
  ADMIN_PASS="${KEYCLOAK_ADMIN_PASSWORD}"
  REALM="${KEYCLOAK_REALM:-lcp}"
  CLIENT_ID="${OIDC_CLIENT_ID:-lcp-server}"
  CLIENT_SECRET="${OIDC_CLIENT_SECRET:-test-stub}"
  TEST_USER="${TEST_USERNAME:-test}"
  TEST_PASS="${TEST_PASSWORD:-test}"

  echo ""
  echo "Configuring Keycloak..."

  kc config credentials \
    --server http://localhost:8080 \
    --realm master \
    --user admin \
    --password "$ADMIN_PASS"

  # Realm
  if ! kc get "realms/$REALM" > /dev/null 2>&1; then
    kc create realms -s "realm=$REALM" -s enabled=true
    echo "  Created realm: $REALM"
  else
    echo "  Realm $REALM: already exists"
  fi

  # Client — confidential; serviceAccountsEnabled so lcp-server can call the
  # Keycloak Admin API; directAccessGrantsEnabled for password-grant token tests.
  CLIENT_INFO=$(kc get clients -r "$REALM" -q "clientId=$CLIENT_ID" 2>&1 || true)
  if echo "$CLIENT_INFO" | grep -q '"id"'; then
    echo "  Client $CLIENT_ID: already exists"
  else
    kc create clients -r "$REALM" \
      -s "clientId=$CLIENT_ID" \
      -s "secret=$CLIENT_SECRET" \
      -s enabled=true \
      -s clientAuthenticatorType=client-secret \
      -s protocol=openid-connect \
      -s serviceAccountsEnabled=true \
      -s directAccessGrantsEnabled=true \
      -s 'redirectUris=["http://localhost:3000/*"]'
    # Grant realm-admin to the service account so lcp-server can manage users
    # via the Keycloak Admin REST API.
    kc add-roles -r "$REALM" \
      --uusername "service-account-$CLIENT_ID" \
      --cclientid realm-management \
      --rolename realm-admin
    echo "  Created client: $CLIENT_ID (service account granted realm-admin)"
  fi

  # Test user
  USER_INFO=$(kc get users -r "$REALM" -q "username=$TEST_USER" 2>&1 || true)
  if echo "$USER_INFO" | grep -q '"id"'; then
    echo "  User $TEST_USER: already exists"
  else
    kc create users -r "$REALM" \
      -s "username=$TEST_USER" \
      -s "email=${TEST_USER}@lcp.local" \
      -s emailVerified=true \
      -s firstName=Test \
      -s lastName=User \
      -s enabled=true
    kc set-password -r "$REALM" \
      --username "$TEST_USER" \
      --new-password "$TEST_PASS"
    echo "  Created user: $TEST_USER"
  fi
fi

# Summary

echo ""
echo "=================================================="
echo "  Deployment ready (project: $PROJECT)"
echo "=================================================="
echo ""
echo "Services:"
echo "  lcp-server API         →  http://localhost:3000"
echo "  lcp-agent              →  http://localhost:3001"
echo "  lcp-mcp-storage        →  http://localhost:3010"
echo "  lcp-mcp-memory         →  http://localhost:3011"
echo "  lcp-mcp-interactions   →  http://localhost:3012"
if [[ -n "$AUTH_PROFILE" ]]; then
  echo "  Keycloak admin         →  http://localhost:8080  (admin / ${KEYCLOAK_ADMIN_PASSWORD})"
fi
echo "  MinIO console          →  http://localhost:9001"
echo ""
if [[ -n "$AUTH_PROFILE" ]]; then
  REALM="${KEYCLOAK_REALM:-lcp}"
  CLIENT_ID="${OIDC_CLIENT_ID:-lcp-server}"
  CLIENT_SECRET="${OIDC_CLIENT_SECRET:-test-stub}"
  TEST_USER="${TEST_USERNAME:-test}"
  TEST_PASS="${TEST_PASSWORD:-test}"
  echo "Test user (realm: $REALM):"
  echo "  Username:  $TEST_USER"
  echo "  Password:  $TEST_PASS"
  echo ""
  echo "Get a token:"
  echo "  curl -s -X POST 'http://localhost:8080/realms/$REALM/protocol/openid-connect/token' \\"
  echo "    -d grant_type=password \\"
  echo "    -d 'client_id=$CLIENT_ID' \\"
  echo "    -d 'client_secret=$CLIENT_SECRET' \\"
  echo "    -d 'username=$TEST_USER' \\"
  echo "    -d 'password=$TEST_PASS' | jq -r .access_token"
  echo ""
fi
