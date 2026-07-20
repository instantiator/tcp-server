#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") --project <name> --env-file <path> [--rebuild] [-h|--help]

Start the LCP Docker Compose stack and configure it for use.

Reads all configuration — including Zitadel credentials and the first test
users — from the env file. If ZITADEL_ADMIN_PASSWORD is set in the env file,
the Zitadel auth profile is enabled and the project, application, and test
users are created automatically. If ZITADEL_ADMIN_PASSWORD is absent or
empty, the auth profile is skipped.

Safe to re-run against an already-running stack: existing Zitadel resources
(project, application, users) are reused, not recreated. Zitadel generates
client secrets server-side (they can't be pre-set the way Keycloak's could)
and they can only be read at generation time, so on EVERY run this script
(re)generates the OIDC_CLIENT_ID/SECRET and TEST_CLIENT_ID/SECRET and writes
them back into the env file in place, before starting lcp-server and its
dependents. Regenerating every run — rather than trusting the file — is what
keeps the env file and Zitadel from silently drifting apart (a wiped-and-
rebootstrapped Zitadel, or a swapped env file, otherwise leaves a stale
secret that fails auth with an opaque 'invalid_client').

Options:
  --project <name>    Docker Compose project name (required)
  --env-file <path>   Path to the env file (required)
  --rebuild           Force a Docker image rebuild before starting
  -h, --help          Show this help message and exit

Zitadel setup reads from the env file:
  ZITADEL_ADMIN_PASSWORD   Org admin (human) password (presence enables auth profile)
  TEST_USERNAME            Human test user to create (default: test)
  TEST_PASSWORD            That user's password (default: test)
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

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "Using: $ENV_FILE"
set -a
# shellcheck disable=SC1090 # env file path is only known at runtime
source "$ENV_FILE"
set +a

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

# Auth profile: enabled when ZITADEL_ADMIN_PASSWORD is set and non-empty.
AUTH_PROFILE=""
if [[ -n "${ZITADEL_ADMIN_PASSWORD:-}" ]]; then
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

# Replaces (or appends) a KEY=value line in an env file. Used to persist
# Zitadel's server-generated client secrets back to disk so a later, separate
# invocation of this script (or run-api-tests.sh) picks up the real value.
set_env_var() {
  local file="$1" key="$2" value="$3"
  local tmp; tmp="$(mktemp)"
  grep -v "^${key}=" "$file" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$file"
}

# Start services

echo ""
echo "Starting infrastructure (project: $PROJECT)..."
INFRA_SERVICES=(postgres redis minio)
[[ -n "$AUTH_PROFILE" ]] && INFRA_SERVICES+=(zitadel)

# Zitadel runs as a non-root user (uid 1000); a fresh named volume would be
# root-owned, so it can't write its bootstrap PAT. This bind-mounted host
# directory must be world-writable before the container starts.
MACHINEKEY_DIR="$REPO_ROOT/docker/zitadel-machinekey"
PAT_FILE="$MACHINEKEY_DIR/pat.txt"
if [[ -n "$AUTH_PROFILE" ]]; then
  mkdir -p "$MACHINEKEY_DIR"
  chmod 777 "$MACHINEKEY_DIR"
fi

# Zitadel only (re)writes pat.txt during first-instance bootstrap, which only
# runs against a genuinely empty DB. Detect that case up front, via the named
# Postgres volume's existence, so the PAT readiness check below knows whether
# to expect a fresh file or trust the one already on disk: on a reused DB,
# bootstrap is skipped and pat.txt is never touched, so requiring a newer
# mtime there would wait forever.
ZITADEL_FRESH_BOOT=false
if [[ -n "$AUTH_PROFILE" ]] && ! docker volume inspect "${PROJECT}_postgres_data" >/dev/null 2>&1; then
  ZITADEL_FRESH_BOOT=true
fi

# On a fresh boot, snapshot any pre-existing PAT's mtime: a file left over
# from an earlier instance would otherwise satisfy a plain "non-empty"
# readiness check immediately, racing against the new instance's own
# (slower) write.
PAT_MTIME_BEFORE=0
if [[ "$ZITADEL_FRESH_BOOT" = true && -f "$PAT_FILE" ]]; then
  PAT_MTIME_BEFORE=$(stat -f %m "$PAT_FILE" 2>/dev/null || stat -c %Y "$PAT_FILE" 2>/dev/null || echo 0)
fi

if [[ "$REBUILD" = "true" ]]; then
  $DC up -d --build "${INFRA_SERVICES[@]}"
else
  $DC up -d "${INFRA_SERVICES[@]}"
fi

if [[ -n "$AUTH_PROFILE" ]]; then
  wait_for zitadel "curl -sf -o /dev/null http://localhost:8080/debug/healthz"
fi

# Zitadel bootstrap (skipped when auth profile is not active). Must happen
# before lcp-server starts: Zitadel generates the OIDC client's secret
# server-side, so lcp-server can only be started with the *correct* secret
# once bootstrap has captured it.
ORG_NAME="lcp"
PROJECT_NAME="lcp"
APP_NAME="lcp-server"
TEST_MACHINE_USERNAME="test-machine"

if [[ -n "$AUTH_PROFILE" ]]; then
  echo ""
  echo "Configuring Zitadel..."

  if [[ "$ZITADEL_FRESH_BOOT" = true ]]; then
    # Fresh DB: wait for a PAT newer than any pre-existing one, not just a
    # non-empty file (see ZITADEL_FRESH_BOOT / PAT_MTIME_BEFORE above).
    # Generous timeout: first-instance bootstrap can be slow on a cold image
    # pull or a busy machine.
    wait_for "Zitadel bootstrap PAT" \
      "[[ -s '$PAT_FILE' ]] && (( \$(stat -f %m '$PAT_FILE' 2>/dev/null || stat -c %Y '$PAT_FILE' 2>/dev/null || echo 0) > $PAT_MTIME_BEFORE ))" \
      180
  else
    # Existing DB: Zitadel skips first-instance bootstrap and never touches
    # pat.txt, so the file already on disk is the one to trust.
    wait_for "Zitadel bootstrap PAT" "[[ -s '$PAT_FILE' ]]"
  fi

  # Wrapper around curl for authenticated Zitadel API calls.
  zit() {
    local method="$1" path="$2" body="${3:-}"
    curl -sf -X "$method" "http://localhost:8080${path}" \
      -H "Authorization: Bearer $ZITADEL_PAT" \
      -H "Content-Type: application/json" \
      ${body:+-d "$body"}
  }

  # Re-read the PAT on each attempt, and gate on a real authenticated call:
  #  - Zitadel rewrites pat.txt during first-instance setup (confirmed: a fresh
  #    boot overwrites a prior instance's file), but /debug/healthz is liveness,
  #    so it can pass in the brief window before the new PAT lands — an early
  #    read would otherwise cache the previous instance's token.
  #  - Even once the PAT is current, the machine user's permissions are
  #    eventually-consistent (a transient auth failure on the very first call
  #    right after first boot).
  # Retrying a re-read call covers both without aborting the script under set -e.
  ORG_ID=""
  for _ in $(seq 1 15); do
    ZITADEL_PAT="$(cat "$PAT_FILE")"
    ORG_ID=$(zit GET "/auth/v1/users/me" 2>/dev/null | jq -r '.user.details.resourceOwner // empty') || true
    [[ -n "$ORG_ID" ]] && break
    sleep 2
  done
  if [[ -z "$ORG_ID" ]]; then
    cat >&2 <<EOF
ERROR: could not authenticate to the Zitadel API with the bootstrap PAT.

This almost always means '$PAT_FILE' is stale — it was written by an earlier
Zitadel instance, but the current Zitadel database no longer recognises it
(the PAT is only (re)written at first-instance init). Reset the two together:

  $DC down -v
  rm -f '$PAT_FILE'
  $0 $*

('down -v' wipes the shared Postgres volume — fine for a dev stack; the app DB
is recreated on the next boot.)
EOF
    exit 1
  fi

  # Project — realm-equivalent grouping for the OIDC application.
  PROJECT_ID=$(zit POST "/management/v1/projects/_search" \
    "$(jq -n --arg n "$PROJECT_NAME" '{queries:[{nameQuery:{name:$n,method:"TEXT_QUERY_METHOD_EQUALS"}}]}')" \
    | jq -r '.result[0].id // empty')
  if [[ -z "$PROJECT_ID" ]]; then
    PROJECT_ID=$(zit POST "/management/v1/projects" "$(jq -n --arg n "$PROJECT_NAME" '{name:$n}')" | jq -r '.id')
    echo "  Created project: $PROJECT_NAME"
  else
    echo "  Project $PROJECT_NAME: already exists"
  fi

  # OIDC application — device-code + refresh-token grants (no ROPC support on
  # Zitadel). accessTokenType must be explicitly JWT: Zitadel otherwise issues
  # opaque/encrypted access tokens that lcp-server's JWKS-based verification
  # cannot parse.
  # A client secret can only be read at generation time, so it can silently
  # drift from the env file (a wiped-and-rebootstrapped Zitadel, or a swapped
  # env file). Rather than trust the file, (re)generate the secret every run
  # and write it back — the env file and Zitadel are then guaranteed to agree.
  APP_LIST=$(zit POST "/management/v1/projects/$PROJECT_ID/apps/_search" '{}')
  APP_ID=$(echo "$APP_LIST" | jq -r --arg n "$APP_NAME" '.result[]? | select(.name == $n) | .id // empty')
  if [[ -z "$APP_ID" ]]; then
    APP=$(zit POST "/management/v1/projects/$PROJECT_ID/apps/oidc" "$(jq -n --arg name "$APP_NAME" '{
      name: $name,
      redirectUris: ["http://localhost:3000/auth/callback"],
      responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
      grantTypes: ["OIDC_GRANT_TYPE_DEVICE_CODE", "OIDC_GRANT_TYPE_REFRESH_TOKEN"],
      appType: "OIDC_APP_TYPE_WEB",
      authMethodType: "OIDC_AUTH_METHOD_TYPE_BASIC",
      accessTokenType: "OIDC_TOKEN_TYPE_JWT"
    }')")
    APP_CLIENT_ID=$(echo "$APP" | jq -r '.clientId')
    APP_CLIENT_SECRET=$(echo "$APP" | jq -r '.clientSecret')
    echo "  Created application: $APP_NAME (client secret written to $ENV_FILE)"
  else
    APP_CLIENT_ID=$(echo "$APP_LIST" | jq -r --arg n "$APP_NAME" '.result[]? | select(.name == $n) | .oidcConfig.clientId // empty')
    APP_CLIENT_SECRET=$(zit POST "/management/v1/projects/$PROJECT_ID/apps/$APP_ID/oidc_config/_generate_client_secret" '{}' | jq -r '.clientSecret')
    echo "  Application $APP_NAME: already exists (client secret regenerated → $ENV_FILE)"
  fi
  set_env_var "$ENV_FILE" OIDC_CLIENT_ID "$APP_CLIENT_ID"
  set_env_var "$ENV_FILE" OIDC_CLIENT_SECRET "$APP_CLIENT_SECRET"
  export OIDC_CLIENT_ID="$APP_CLIENT_ID"
  export OIDC_CLIENT_SECRET="$APP_CLIENT_SECRET"

  # Human test user — for manually exercising `lcp-cli get-token`'s device-flow login.
  TEST_USER="${TEST_USERNAME:-test}"
  TEST_PASS="${TEST_PASSWORD:-test}"
  EXISTING_USER=$(zit POST "/management/v1/users/_search" \
    "$(jq -n --arg u "$TEST_USER" '{queries:[{userNameQuery:{userName:$u,method:"TEXT_QUERY_METHOD_EQUALS"}}]}')" \
    | jq -r '.result[0].id // empty')
  if [[ -z "$EXISTING_USER" ]]; then
    zit POST "/v2/users/new" "$(jq -n --arg org "$ORG_ID" --arg u "$TEST_USER" --arg p "$TEST_PASS" '{
      organizationId: $org,
      username: $u,
      human: {
        profile: {givenName: "Test", familyName: "User"},
        email: {email: ($u + "@lcp.local"), isVerified: true},
        password: {password: $p}
      }
    }')" > /dev/null
    echo "  Created user: $TEST_USER"
  else
    echo "  User $TEST_USER: already exists"
  fi

  # Machine test user (client_credentials) — used by the api test tier instead
  # of a human login, since device-flow login requires a human in a browser.
  # Same drift problem as the app secret above: (re)generate it every run and
  # write it back, so the api tier's TEST_CLIENT_SECRET always matches Zitadel.
  MACHINE_ID=$(zit POST "/management/v1/users/_search" \
    "$(jq -n --arg u "$TEST_MACHINE_USERNAME" '{queries:[{userNameQuery:{userName:$u,method:"TEXT_QUERY_METHOD_EQUALS"}}]}')" \
    | jq -r '.result[0].id // empty')
  if [[ -z "$MACHINE_ID" ]]; then
    MACHINE_ID=$(zit POST "/v2/users/new" "$(jq -n --arg org "$ORG_ID" --arg u "$TEST_MACHINE_USERNAME" '{
      organizationId: $org,
      username: $u,
      machine: {name: "LCP API Test Machine", accessTokenType: "ACCESS_TOKEN_TYPE_JWT"}
    }')" | jq -r '.id')
    echo "  Created machine user: $TEST_MACHINE_USERNAME (client secret written to $ENV_FILE)"
  else
    echo "  Machine user $TEST_MACHINE_USERNAME: already exists (client secret regenerated → $ENV_FILE)"
  fi
  SECRET=$(zit PUT "/management/v1/users/$MACHINE_ID/secret" '{}')
  MACHINE_CLIENT_ID=$(echo "$SECRET" | jq -r '.clientId')
  MACHINE_CLIENT_SECRET=$(echo "$SECRET" | jq -r '.clientSecret')
  set_env_var "$ENV_FILE" TEST_CLIENT_ID "$MACHINE_CLIENT_ID"
  set_env_var "$ENV_FILE" TEST_CLIENT_SECRET "$MACHINE_CLIENT_SECRET"
  export TEST_CLIENT_ID="$MACHINE_CLIENT_ID"
  export TEST_CLIENT_SECRET="$MACHINE_CLIENT_SECRET"
fi

echo ""
echo "Starting application services (project: $PROJECT)..."
if [[ "$REBUILD" = "true" ]]; then
  $DC up -d --build
else
  $DC up -d
fi

wait_for lcp-server           "curl -sf http://localhost:3000/health"
wait_for lcp-agent            "curl -sf http://localhost:3001/health"
wait_for lcp-mcp-storage      "curl -sf http://localhost:3010/health"
wait_for lcp-mcp-memory       "curl -sf http://localhost:3011/health"
wait_for lcp-mcp-interactions "curl -sf http://localhost:3012/health"
wait_for lcp-mcp-tasks        "curl -sf http://localhost:3013/health"

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
echo "  lcp-mcp-tasks          →  http://localhost:3013"
if [[ -n "$AUTH_PROFILE" ]]; then
  echo "  Zitadel console        →  http://localhost:8080/ui/console  (admin / ${ZITADEL_ADMIN_PASSWORD})"
fi
echo "  MinIO console          →  http://localhost:9001"
echo ""
if [[ -n "$AUTH_PROFILE" ]]; then
  TEST_USER="${TEST_USERNAME:-test}"
  TEST_PASS="${TEST_PASSWORD:-test}"
  echo "Test user (org: $ORG_NAME):"
  echo "  Username:  $TEST_USER"
  echo "  Password:  $TEST_PASS"
  echo ""
  echo "Get a token (opens a browser for login):"
  echo "  npx lcp-cli get-token"
  echo ""
fi
