#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") --project <name> (--env-file <path> | --env-files <f1,f2,...>) [--rebuild] [--dev-ports] [--dev-web] [-h|--help]

Start the TCP Docker Compose stack and configure it for use.

By default, the MCP servers and stub-llm are internal-only (not reachable from
the host) — the production-safe posture. Pass --dev-ports to additionally
publish their ports (docker-compose.dev-ports.yml) for direct host access,
e.g. manual debugging or the smoke-test tier. Pass --dev-web to point tcp-web
at a Vite dev server on the host instead of a built bundle
(docker-compose.dev-web.yml), for frontend development with HMR.

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
them to the gitignored '<env-file>.local' override (never the committed base
file), before starting tcp-server and its dependents. Regenerating every run —
rather than trusting the file — is what keeps the credentials and Zitadel from
silently drifting apart (a wiped-and-rebootstrapped Zitadel, or a swapped env
file, otherwise leaves a stale secret that fails auth with an opaque
'invalid_client').

Options:
  --project <name>        Docker Compose project name (required)
  --env-file <path>       Path to the env file (required, single file)
  --env-files <f1,f2,...> Comma-separated env files in precedence order (first wins)
  --rebuild               Force a Docker image rebuild before starting
  --dev-ports             Publish MCP server / stub-llm ports to the host (non-production)
  --dev-web               Point tcp-web at a host Vite dev server instead of a built bundle
  -h, --help              Show this help message and exit

Env file precedence (when using --env-files):
  Files are loaded in order; first value wins. Example:
    --env-files .env.dev

Zitadel setup reads from the env file:
  ZITADEL_ADMIN_PASSWORD   Org admin (human) password (presence enables auth profile)
  TEST_USERNAME            Human test user to create (default: test)
  TEST_PASSWORD            That user's password (default: test)

Optional services:
  STUB_LLM=true            Also run the stub LLM (canned replies; see docs/stub-llm.md)
EOF
}

PROJECT=""
ENV_FILE=""
ENV_FILES=""
REBUILD=false
DEV_PORTS=false
DEV_WEB=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      [[ -n "${2:-}" ]] || { echo "ERROR: --project requires a value" >&2; exit 1; }
      PROJECT="$2"; shift 2 ;;
    --env-file)
      [[ -n "${2:-}" ]] || { echo "ERROR: --env-file requires a path" >&2; exit 1; }
      ENV_FILE="$2"; shift 2 ;;
    --env-files)
      [[ -n "${2:-}" ]] || { echo "ERROR: --env-files requires a comma-separated list" >&2; exit 1; }
      ENV_FILES="$2"; shift 2 ;;
    --rebuild) REBUILD=true; shift ;;
    --dev-ports) DEV_PORTS=true; shift ;;
    --dev-web) DEV_WEB=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

[[ -n "$PROJECT" ]]  || { echo "ERROR: --project is required" >&2; usage >&2; exit 1; }
[[ -n "$ENV_FILE" || -n "$ENV_FILES" ]] || { echo "ERROR: --env-file or --env-files is required" >&2; usage >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/lib/load-env.sh
# shellcheck disable=SC1091 # source path resolved at runtime
source "$REPO_ROOT/scripts/lib/load-env.sh"
# shellcheck source=scripts/lib/errors.sh
# shellcheck disable=SC1091 # source path resolved at runtime
source "$REPO_ROOT/scripts/lib/errors.sh"
enable_error_report

if [[ -n "$ENV_FILES" ]]; then
  # Convert comma-separated list to array, validate files exist
  IFS=',' read -ra ENV_FILES_ARRAY <<< "$ENV_FILES"
  for f in "${ENV_FILES_ARRAY[@]}"; do
    [[ -f "$f" ]] || { echo "ERROR: env file not found: $f" >&2; exit 1; }
  done
  echo "Loading env files (precedence order): ${ENV_FILES_ARRAY[*]}"
  set -a
  load_env_files "${ENV_FILES_ARRAY[@]}"
  set +a
  # Use the first file for Zitadel setup writes
  ENV_FILE="${ENV_FILES_ARRAY[0]}"
else
  [[ -f "$ENV_FILE" ]] || { echo "ERROR: env file not found: $ENV_FILE" >&2; exit 1; }
  echo "Using: $ENV_FILE"
  set -a
  # shellcheck disable=SC1090 # env file path is only known at runtime
  source "$ENV_FILE"
  set +a
fi

# Gitignored per-instance override holding generated/provider-issued secrets
# (OIDC_CLIENT_ID/SECRET, TEST_CLIENT_ID/SECRET — the LOCAL_ONLY_ENV_KEYS from
# libs/tcp-shared/src/config/local-env-keys.ts). Layered on top of the committed
# base file (local wins) and where this script writes Zitadel's bootstrap
# output. Created empty here so it always exists for the docker compose
# `--env-file` below and for the later writes.
LOCAL_ENV_FILE="${ENV_FILE}.local"
touch "$LOCAL_ENV_FILE"
set -a
# shellcheck disable=SC1090 # env file path is only known at runtime
source "$LOCAL_ENV_FILE"
set +a

# Derive host-facing URLs from EXPOSE_PORT_* and DB_* variables.
# shellcheck source=scripts/lib/derive-urls.sh
# shellcheck disable=SC1091 # source path resolved at runtime
source "$REPO_ROOT/scripts/lib/derive-urls.sh"
derive_host_urls

# Auth profile: enabled when ZITADEL_ADMIN_PASSWORD is set and non-empty. When
# active, this script bootstraps a local Zitadel and GENERATES the OIDC client
# credentials, so they need not be present up front; without it (external OIDC
# provider) they must already be supplied in the base file or its .local override.
AUTH_PROFILE=""
if [[ -n "${ZITADEL_ADMIN_PASSWORD:-}" ]]; then
  AUTH_PROFILE="--profile auth"
fi

# The bundled Zitadel only works on host port 8080: its external port
# (ZITADEL_EXTERNALPORT in docker-compose.yml) and the bootstrap below (zit())
# both assume it, and a different EXPOSE_PORT_ZITADEL would publish it where
# neither looks. Refuse it here rather than fail halfway through the bootstrap.
if [[ -n "$AUTH_PROFILE" && "${EXPOSE_PORT_ZITADEL:-8080}" != 8080 ]]; then
  cat >&2 <<EOF
ERROR: EXPOSE_PORT_ZITADEL is ${EXPOSE_PORT_ZITADEL}, but the bundled Zitadel only works on port 8080.
Remove EXPOSE_PORT_ZITADEL from $ENV_FILE. If another stack holds 8080, stop it
first: ./scripts/stop-dev.sh --project <name>
EOF
  exit 1
fi

# Stub LLM: runs in this stack only when asked (the setup wizard's "no real
# model" option). The test tiers start it themselves.
STUB_PROFILE=""
if [[ "${STUB_LLM:-}" == "true" ]]; then
  STUB_PROFILE="--profile integration"
fi

# Pre-flight: verify all required variables are non-empty.
# DATABASE_URL, MINIO_ENDPOINT, OIDC_ISSUER_URL, and TCP_SERVER_URL are
# derived above from EXPOSE_PORT_* and DB_* — they don't need to be in the env file.
REQUIRED_VARS=(
  DB_PASSWORD MINIO_ACCESS_KEY MINIO_SECRET_KEY
  INTERNAL_API_KEY
)
# OIDC client creds are generated by the Zitadel bootstrap when the auth profile
# is active; require them up front only for an external provider.
if [[ -z "$AUTH_PROFILE" ]]; then
  REQUIRED_VARS+=(OIDC_CLIENT_ID OIDC_CLIENT_SECRET)
fi
missing=()
for var in "${REQUIRED_VARS[@]}"; do
  [[ -n "${!var:-}" ]] || missing+=("$var")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "" >&2
  echo "ERROR: the following required variables are missing or empty:" >&2
  for var in "${missing[@]}"; do echo "  $var" >&2; done
  echo "" >&2
  echo "Add them to $ENV_FILE (or its $LOCAL_ENV_FILE override). See .env.example for reference values." >&2
  echo "" >&2
  exit 1
fi

COMPOSE_FILES="-f $REPO_ROOT/docker-compose.yml"
if [[ "$DEV_PORTS" = "true" ]]; then
  COMPOSE_FILES="$COMPOSE_FILES -f $REPO_ROOT/docker-compose.dev-ports.yml"
fi
if [[ "$DEV_WEB" = "true" ]]; then
  COMPOSE_FILES="$COMPOSE_FILES -f $REPO_ROOT/docker-compose.dev-web.yml"
fi

# Both env files feed Compose interpolation; the .local override is passed last
# so its generated OIDC_CLIENT_* win over any base-file placeholder.
DC="docker compose -p $PROJECT $COMPOSE_FILES $AUTH_PROFILE $STUB_PROFILE --env-file $ENV_FILE --env-file $LOCAL_ENV_FILE"

wait_for() {
  local name="$1" cmd="$2" max="${3:-120}"
  local waited=0
  echo "Waiting for $name..."
  until eval "$cmd" 2>/dev/null; do
    sleep 3; waited=$((waited + 3))
    if [[ "$waited" -ge "$max" ]]; then
      echo "ERROR: Timed out waiting for $name after ${max}s" >&2
      $DC logs --tail=20
      echo "" >&2
      echo "Check '$DC logs <service>' — a service that exits on startup usually names the bad setting there." >&2
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
#
# Scoped by $PROJECT to match docker-compose.yml's zitadel volume mount
# (./docker/zitadel-machinekey/${COMPOSE_PROJECT_NAME}): each Compose project
# has its own independently-bootstrapped Zitadel instance tied to its own
# Postgres volume, so its PAT file must be scoped the same way — otherwise
# two projects (e.g. a `tcp-dev` stack and a `tcp-api`/`tcp-all` test run)
# sharing one unscoped pat.txt would silently overwrite each other's PAT,
# leaving whichever project didn't bootstrap most recently with a PAT that
# authenticates fine but against the wrong Zitadel instance's admin API.
MACHINEKEY_DIR="$REPO_ROOT/docker/zitadel-machinekey/$PROJECT"
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
#
# GNU stat first, BSD stat as fallback — NOT the other way round. GNU stat's
# `-f` means "filesystem status" (a different mode entirely, not BSD's
# `-f format`); given a file argument it still exits non-zero, but only after
# printing filesystem info to stdout, which the outer `$(...)` would capture
# ahead of the real fallback's output. Swapping the order broke CI (Linux)
# while working fine in local dev (macOS) — the mismatched output silently
# fed multi-line garbage into the `(( ... > ... ))` arithmetic check that
# guards this, aborting the script under `set -e`.
PAT_MTIME_BEFORE=0
if [[ "$ZITADEL_FRESH_BOOT" = true && -f "$PAT_FILE" ]]; then
  PAT_MTIME_BEFORE=$(stat -c %Y "$PAT_FILE" 2>/dev/null || stat -f %m "$PAT_FILE" 2>/dev/null || echo 0)
fi

# Verify exposed ports are available before starting services.
# shellcheck source=scripts/lib/check-ports.sh
# shellcheck disable=SC1091 # source path resolved at runtime
source "$REPO_ROOT/scripts/lib/check-ports.sh"
check_exposed_ports

step "starting the infrastructure containers (${INFRA_SERVICES[*]})" \
  "Docker's own error is above. A failed image pull usually means no network; 'port is already allocated' means another stack holds the port."
if [[ "$REBUILD" = "true" ]]; then
  $DC up -d --build "${INFRA_SERVICES[@]}"
else
  $DC up -d "${INFRA_SERVICES[@]}"
fi

if [[ -n "$AUTH_PROFILE" ]]; then
  wait_for zitadel "curl -sf -o /dev/null http://localhost:${EXPOSE_PORT_ZITADEL:-8080}/debug/healthz"
fi

# Zitadel bootstrap (skipped when auth profile is not active). Must happen
# before tcp-server starts: Zitadel generates the OIDC client's secret
# server-side, so tcp-server can only be started with the *correct* secret
# once bootstrap has captured it.
ORG_NAME="tcp"
PROJECT_NAME="tcp"
APP_NAME="tcp-server"
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
      "[[ -s '$PAT_FILE' ]] && (( \$(stat -c %Y '$PAT_FILE' 2>/dev/null || stat -f %m '$PAT_FILE' 2>/dev/null || echo 0) > $PAT_MTIME_BEFORE ))" \
      180
  else
    # Existing DB: Zitadel skips first-instance bootstrap and never touches
    # pat.txt, so the file already on disk is the one to trust.
    wait_for "Zitadel bootstrap PAT" "[[ -s '$PAT_FILE' ]]"
  fi

  # Wrapper around curl for authenticated Zitadel API calls. Prints the body
  # on success; on failure returns non-zero and says what Zitadel answered on
  # stderr (callers that expect failure silence it with 2>/dev/null).
  zit() {
    local method="$1" path="$2" body="${3:-}" response status
    if ! response=$(curl -s -w '\n%{http_code}' -X "$method" "http://localhost:8080${path}" \
      -H "Authorization: Bearer $ZITADEL_PAT" \
      -H "Content-Type: application/json" \
      ${body:+-d "$body"}); then
      echo "  Zitadel $method $path: no response — is Zitadel still running? ($DC logs zitadel)" >&2
      return 1
    fi
    status="${response##*$'\n'}"
    response="${response%$'\n'*}"
    if [[ "$status" != 2* ]]; then
      echo "  Zitadel $method $path → HTTP $status: ${response:0:500}" >&2
      return 1
    fi
    printf '%s\n' "$response"
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

  step "setting up the Zitadel project, applications and test users" \
    "Zitadel's answer is printed above. If it rejects the admin token, the PAT is stale: run '$DC down -v', delete '$PAT_FILE', and re-run."

  # Project — realm-equivalent grouping for the OIDC application.
  PROJECT_ID=$(zit POST "/management/v1/projects/_search" \
    "$(jq -n --arg n "$PROJECT_NAME" '{queries:[{nameQuery:{name:$n,method:"TEXT_QUERY_METHOD_EQUALS"}}]}')" \
    | json_field "a Zitadel search" '.result[0].id // empty')
  if [[ -z "$PROJECT_ID" ]]; then
    PROJECT_ID=$(zit POST "/management/v1/projects" "$(jq -n --arg n "$PROJECT_NAME" '{name:$n}')" | json_field "creating the Zitadel project" '.id')
    echo "  Created project: $PROJECT_NAME"
  else
    echo "  Project $PROJECT_NAME: already exists"
  fi

  # CLI application — device-code + refresh-token grants (no ROPC support on
  # Zitadel). accessTokenType must be explicitly JWT: Zitadel otherwise issues
  # opaque/encrypted access tokens that tcp-server's JWKS-based verification
  # cannot parse.
  # A client secret can only be read at generation time, so it can silently
  # drift from the env file (a wiped-and-rebootstrapped Zitadel, or a swapped
  # env file). Rather than trust the file, (re)generate the secret every run
  # and write it back — the env file and Zitadel are then guaranteed to agree.
  APP_LIST=$(zit POST "/management/v1/projects/$PROJECT_ID/apps/_search" '{}')
  # Checked once here, so the lookups below can use jq's --arg directly.
  json_field "the Zitadel application list" . <<<"$APP_LIST" >/dev/null
  APP_ID=$(echo "$APP_LIST" | jq -r --arg n "$APP_NAME" '.result[]? | select(.name == $n) | .id // empty')
  if [[ -z "$APP_ID" ]]; then
    APP=$(zit POST "/management/v1/projects/$PROJECT_ID/apps/oidc" "$(jq -n --arg name "$APP_NAME" --arg cb "http://localhost:${EXPOSE_PORT_API:-3000}/auth/callback" '{
      name: $name,
      redirectUris: [$cb],
      responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
      grantTypes: ["OIDC_GRANT_TYPE_DEVICE_CODE", "OIDC_GRANT_TYPE_REFRESH_TOKEN"],
      appType: "OIDC_APP_TYPE_WEB",
      authMethodType: "OIDC_AUTH_METHOD_TYPE_BASIC",
      accessTokenType: "OIDC_TOKEN_TYPE_JWT"
    }')")
    APP_CLIENT_ID=$(json_field "creating the tcp-server application" '.clientId' <<<"$APP")
    APP_CLIENT_SECRET=$(json_field "creating the tcp-server application" '.clientSecret' <<<"$APP")
    echo "  Created application: $APP_NAME (client secret written to $LOCAL_ENV_FILE)"
  else
    APP_CLIENT_ID=$(echo "$APP_LIST" | jq -r --arg n "$APP_NAME" '.result[]? | select(.name == $n) | .oidcConfig.clientId // empty')
    APP_CLIENT_SECRET=$(zit POST "/management/v1/projects/$PROJECT_ID/apps/$APP_ID/oidc_config/_generate_client_secret" '{}' | json_field "regenerating the tcp-server client secret" '.clientSecret')
    echo "  Application $APP_NAME: already exists (client secret regenerated → $LOCAL_ENV_FILE)"
  fi
  set_env_var "$LOCAL_ENV_FILE" OIDC_CLIENT_ID "$APP_CLIENT_ID"
  set_env_var "$LOCAL_ENV_FILE" OIDC_CLIENT_SECRET "$APP_CLIENT_SECRET"
  export OIDC_CLIENT_ID="$APP_CLIENT_ID"
  export OIDC_CLIENT_SECRET="$APP_CLIENT_SECRET"

  # Browser application — a public client using Authorization Code with PKCE
  # (ADR-024). No secret: a browser cannot keep one, so there is none to
  # regenerate and nothing to drift. accessTokenType is JWT for the same
  # reason as the CLI's client above.
  #
  # Redirect URIs come from TCP_WEB_URL (scripts/lib/derive-urls.sh), which is
  # https because tcp-web is TLS-only (ADR-029). A hardcoded port would work in
  # development and fail sign-in on .env.testing's 5174, with a provider-side
  # error that never names the port.
  #
  # devMode relaxes Zitadel's redirect-URI validation for localhost. This
  # bootstrap only ever targets the bundled localhost Zitadel; a real
  # deployment registers its client by hand.
  WEB_APP_NAME="tcp-web"
  WEB_APP_ID=$(echo "$APP_LIST" | jq -r --arg n "$WEB_APP_NAME" '.result[]? | select(.name == $n) | .id // empty')
  WEB_APP_CONFIG=$(jq -n --arg cb "${TCP_WEB_URL}/callback" --arg home "${TCP_WEB_URL}/" '{
    redirectUris: [$cb],
    postLogoutRedirectUris: [$home],
    responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
    grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE"],
    appType: "OIDC_APP_TYPE_USER_AGENT",
    authMethodType: "OIDC_AUTH_METHOD_TYPE_NONE",
    accessTokenType: "OIDC_TOKEN_TYPE_JWT",
    devMode: true
  }')
  if [[ -z "$WEB_APP_ID" ]]; then
    OIDC_WEB_CLIENT_ID=$(zit POST "/management/v1/projects/$PROJECT_ID/apps/oidc" \
      "$(echo "$WEB_APP_CONFIG" | jq --arg name "$WEB_APP_NAME" '. + {name: $name}')" \
      | json_field "creating the tcp-web application" '.clientId')
    echo "  Created application: $WEB_APP_NAME (public PKCE client, no secret)"
  else
    OIDC_WEB_CLIENT_ID=$(echo "$APP_LIST" | jq -r --arg n "$WEB_APP_NAME" '.result[]? | select(.name == $n) | .oidcConfig.clientId // empty')
    # The redirect URI moves with EXPOSE_PORT_WEB, and a reused Zitadel volume
    # would otherwise keep the previous port's — which fails at the very end of
    # an otherwise-working sign-in. So rewrite it when it has moved.
    #
    # Only when it has moved: Zitadel answers an update that changes nothing
    # with 400 "No changes", and zit() uses `curl -sf`, so an unconditional
    # rewrite aborts the whole script on the second run of an unchanged stack.
    WEB_APP_URIS=$(echo "$APP_LIST" | jq -r --arg n "$WEB_APP_NAME" '.result[]? | select(.name == $n) | .oidcConfig.redirectUris // [] | join(",")')
    if [[ "$WEB_APP_URIS" != "${TCP_WEB_URL}/callback" ]]; then
      zit PUT "/management/v1/projects/$PROJECT_ID/apps/$WEB_APP_ID/oidc_config" "$WEB_APP_CONFIG" > /dev/null
      echo "  Application $WEB_APP_NAME: redirect URIs rewritten to $TCP_WEB_URL"
    else
      echo "  Application $WEB_APP_NAME: already exists"
    fi
  fi
  set_env_var "$LOCAL_ENV_FILE" OIDC_WEB_CLIENT_ID "$OIDC_WEB_CLIENT_ID"
  export OIDC_WEB_CLIENT_ID

  # No second factors on the org's login policy.
  #
  # Zitadel offers a "2-Factor Setup" screen on a human's first sign-in when the
  # policy lists a second factor and the user has none. It is only an offer —
  # there is a Skip button, and MFA is not enforced either way — but it stands
  # between the login form and the application, which breaks the browser tier's
  # sign-in harness (007.03) on any freshly bootstrapped org. It bit the testing
  # deployment while the older dev org went straight through, so the two
  # environments disagreed about what signing in looks like.
  #
  # Removing the factors is the fix rather than teaching the harness to click
  # Skip: a conditional step in a test is a step nobody can tell has stopped
  # running. This is a local development provider whose password lives in a
  # committed env file, so an MFA prompt was never protecting anything here.
  # A real deployment configures its own provider (docs/authentication.md).
  #
  # The **instance** default policy, via the admin API: the org carries no
  # policy of its own (`isDefault: true`), so a management-API delete has
  # nothing to act on and silently changes nothing. The type is the full enum
  # name — `OTP` alone is rejected as "not valid".
  #
  # Already-absent factors return a non-2xx on later runs, and `zit()` uses
  # `curl -sf`, so this must not abort the script — hence `|| true`.
  for factor in SECOND_FACTOR_TYPE_OTP SECOND_FACTOR_TYPE_U2F; do
    zit DELETE "/admin/v1/policies/login/second_factors/$factor" >/dev/null 2>&1 || true
  done

  # Human test user — for manually exercising `tcp-cli get-token`'s device-flow
  # login, and for the browser tier's sign-in harness (007.03).
  TEST_USER="${TEST_USERNAME:-test}"
  TEST_PASS="${TEST_PASSWORD:-test}"
  EXISTING_USER=$(zit POST "/management/v1/users/_search" \
    "$(jq -n --arg u "$TEST_USER" '{queries:[{userNameQuery:{userName:$u,method:"TEXT_QUERY_METHOD_EQUALS"}}]}')" \
    | json_field "a Zitadel search" '.result[0].id // empty')
  if [[ -z "$EXISTING_USER" ]]; then
    TEST_USER_ID=$(zit POST "/v2/users/new" "$(jq -n --arg org "$ORG_ID" --arg u "$TEST_USER" --arg p "$TEST_PASS" '{
      organizationId: $org,
      username: $u,
      human: {
        profile: {givenName: "Test", familyName: "User"},
        email: {email: ($u + "@tcp.local"), isVerified: true},
        password: {password: $p}
      }
    }')" | json_field "creating the test user" '.id')
    echo "  Created user: $TEST_USER"
  else
    TEST_USER_ID="$EXISTING_USER"
    echo "  User $TEST_USER: already exists"
  fi

  # Machine test user (client_credentials) — used by the api test tier instead
  # of a human login, since device-flow login requires a human in a browser.
  # Same drift problem as the app secret above: (re)generate it every run and
  # write it back, so the api tier's TEST_CLIENT_SECRET always matches Zitadel.
  MACHINE_ID=$(zit POST "/management/v1/users/_search" \
    "$(jq -n --arg u "$TEST_MACHINE_USERNAME" '{queries:[{userNameQuery:{userName:$u,method:"TEXT_QUERY_METHOD_EQUALS"}}]}')" \
    | json_field "a Zitadel search" '.result[0].id // empty')
  if [[ -z "$MACHINE_ID" ]]; then
    MACHINE_ID=$(zit POST "/v2/users/new" "$(jq -n --arg org "$ORG_ID" --arg u "$TEST_MACHINE_USERNAME" '{
      organizationId: $org,
      username: $u,
      machine: {name: "TCP API Test Machine", accessTokenType: "ACCESS_TOKEN_TYPE_JWT"}
    }')" | json_field "creating the machine test user" '.id')
    echo "  Created machine user: $TEST_MACHINE_USERNAME (client secret written to $LOCAL_ENV_FILE)"
  else
    echo "  Machine user $TEST_MACHINE_USERNAME: already exists (client secret regenerated → $LOCAL_ENV_FILE)"
  fi
  SECRET=$(zit PUT "/management/v1/users/$MACHINE_ID/secret" '{}')
  MACHINE_CLIENT_ID=$(json_field "the machine user's new secret" '.clientId' <<<"$SECRET")
  MACHINE_CLIENT_SECRET=$(json_field "the machine user's new secret" '.clientSecret' <<<"$SECRET")
  set_env_var "$LOCAL_ENV_FILE" TEST_CLIENT_ID "$MACHINE_CLIENT_ID"
  set_env_var "$LOCAL_ENV_FILE" TEST_CLIENT_SECRET "$MACHINE_CLIENT_SECRET"
  export TEST_CLIENT_ID="$MACHINE_CLIENT_ID"
  export TEST_CLIENT_SECRET="$MACHINE_CLIENT_SECRET"

  # Administrators (002.05). Membership decides who reaches which company;
  # `?all=true` and the /api/system routes need someone above that, and until
  # permission groups exist that is this list. Both ids are regenerated with
  # the bundled Zitadel, so they belong in the .local override rather than a
  # committed file: the human user administers via tcp-cli, the machine user
  # is what the api test tier signs in as. A deployment against an external
  # provider sets TCP_ADMIN_IDENTIFIERS itself — see docs/authentication.md.
  set_env_var "$LOCAL_ENV_FILE" TCP_ADMIN_IDENTIFIERS "$TEST_USER_ID,$MACHINE_ID"
  export TCP_ADMIN_IDENTIFIERS="$TEST_USER_ID,$MACHINE_ID"
fi

echo ""
echo "Starting application services (project: $PROJECT)..."
step "starting the application containers" \
  "Docker's own error is above. A build failure names the Dockerfile step; re-run with --rebuild after fixing it."
if [[ "$REBUILD" = "true" ]]; then
  $DC up -d --build
else
  $DC up -d
fi

step "waiting for the services to report healthy" \
  "The logs above name the service that didn't come up."
wait_for tcp-server           "curl -sf http://localhost:${EXPOSE_PORT_API:-3000}/health"
# tcp-agent and the MCP servers are internal-only by default (no published
# host port unless --dev-ports) — poll via `exec` into the container instead
# of the host, so this works the same whether or not the port is published.
wait_for tcp-mcp-storage      "$DC exec -T tcp-mcp-storage curl -sf http://localhost:3010/health"
wait_for tcp-mcp-memory       "$DC exec -T tcp-mcp-memory curl -sf http://localhost:3011/health"
wait_for tcp-mcp-interactions "$DC exec -T tcp-mcp-interactions curl -sf http://localhost:3012/health"
wait_for tcp-mcp-tasks        "$DC exec -T tcp-mcp-tasks curl -sf http://localhost:3013/health"
# -k: the default certificate is self-signed until a real one is mounted. This
# probe matters — without it, the script would print "Deployment ready" while
# nginx might still be generating its certificate or picking a config, the
# exact race that makes a browser tier flaky against a just-started stack.
wait_for tcp-web              "curl -skf -o /dev/null https://localhost:${EXPOSE_PORT_WEB:-5173}/config.js"

# Summary

echo ""
echo "=================================================="
echo "  Deployment ready (project: $PROJECT)"
echo "=================================================="
echo ""
echo "Services:"
echo "  tcp-server API         →  http://localhost:${EXPOSE_PORT_API:-3000}"
echo "  Web app                →  $TCP_WEB_URL"
if [[ "$DEV_PORTS" = "true" ]]; then
  echo "  tcp-mcp-storage        →  http://localhost:3010"
  echo "  tcp-mcp-memory         →  http://localhost:3011"
  echo "  tcp-mcp-interactions   →  http://localhost:3012"
  echo "  tcp-mcp-tasks          →  http://localhost:3013"
else
  echo "  tcp-mcp-*              →  internal only (rerun with --dev-ports to publish)"
fi
if [[ -n "$AUTH_PROFILE" ]]; then
  echo "  Zitadel console        →  http://localhost:8080/ui/console  (admin / ${ZITADEL_ADMIN_PASSWORD})"
  echo "  OIDC web client ID     →  $OIDC_WEB_CLIENT_ID"
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
  echo "  ./tcp-cli.sh get-token"
  echo ""
fi

# The landing page is where a person starts, so it is the last thing printed
# rather than one row in the service table. https, and self-signed unless a
# real certificate is mounted, so expect a browser warning on first visit —
# see docs/web-client.md for the mkcert route.
echo "Open the landing page:"
echo "  $TCP_WEB_URL"
echo ""
echo "  NB. On first use, you may need to click through a certificate warning."
echo ""