#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<EOF
Usage: $(basename "$0") [-h|--help] [-e|--env <path>] [--rebuild] [--dev-web] [--reset]

Start a full local development environment and configure it for first-time use.

Starts all services via Docker Compose (including Zitadel when
ZITADEL_ADMIN_PASSWORD is set), waits for each to be healthy, then creates
the Zitadel project, application, and test users. Safe to re-run — existing
resources are left untouched.

Credentials for the Zitadel org and test users are read from the env file
(TEST_USERNAME, TEST_PASSWORD). Add or override them there.

Environment file precedence (first match wins):
  1. --env <path>      if provided
  2. .env.dev          if present in the repo root
  3. .env.testing      fallback (always present, safe test credentials)

Options:
  -e, --env <path>   Environment file to use
  --rebuild          Force a Docker image rebuild (passes --build to docker compose up)
  --dev-web          Serve the web client from a Vite dev server instead of the
                     built bundle: starts it on the host and points tcp-web at
                     it. Gives HMR, and is the only mode in which
                     development-only capabilities exist at all — they are
                     compiled out of a production build (docs/web-client.md).
  --reset            Tear down the tcp-dev project first (containers AND
                     volumes — every database is wiped), then, once the fresh
                     stack is up, seed it with a couple of basic test
                     companies and roles via tcp-cli.sh. Use this for a known
                     clean starting point; without it, start-dev.sh never
                     touches existing data.
  -h, --help         Show this help message and exit
EOF
}

ENV_FILE=""
REBUILD=false
DEV_WEB=false
RESET=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -e|--env)
      [[ -n "${2:-}" ]] || { echo "ERROR: --env requires a path" >&2; exit 1; }
      ENV_FILE="$2"; shift 2 ;;
    --rebuild) REBUILD=true; shift ;;
    --dev-web) DEV_WEB=true; shift ;;
    --reset) RESET=true; shift ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# Resolve env file (cascade: .env.dev → .env.testing)
PRIMARY_ENV=""
if [[ -n "$ENV_FILE" ]]; then
  PRIMARY_ENV="$ENV_FILE"
elif [[ -f "$REPO_ROOT/.env.dev" ]]; then
  PRIMARY_ENV="$REPO_ROOT/.env.dev"
else
  PRIMARY_ENV="$REPO_ROOT/.env.testing"
fi

[[ -f "$PRIMARY_ENV" ]] || { echo "ERROR: env file not found: $PRIMARY_ENV" >&2; exit 1; }

# --reset: tear down the project (containers and volumes) before doing
# anything else, so what follows always starts from an empty database —
# reusing stop-dev.sh rather than duplicating its compose invocation.
if [[ "$RESET" == true ]]; then
  echo "Resetting: removing the tcp-dev project's containers and volumes..."
  "$REPO_ROOT/scripts/stop-dev.sh" --env "$PRIMARY_ENV" --volumes
  echo ""
fi

ARGS=(--project tcp-dev --env-files "$PRIMARY_ENV" --dev-ports)
[[ "$REBUILD" == true ]] && ARGS+=(--rebuild)

# The Vite dev server, when --dev-web asks for one.
#
# It has to be answering *before* the deployment starts, not after: with the
# overlay in place nginx proxies to it, and start-deployment.sh waits on
# tcp-web serving /config.js — which it cannot do while the upstream is
# refusing connections.
DEV_WEB_PID_FILE="$REPO_ROOT/.tcp-web-dev.pid"
DEV_WEB_LOG="$REPO_ROOT/logs/vite-dev.log"

# Read the port from the same env file the deployment uses, so this and
# docker-compose.dev-web.yml's WEB_UPSTREAM cannot disagree. Sourced in a
# subshell: this script deliberately does not carry the env file's variables
# into start-deployment.sh, which loads them itself with its own precedence.
read_dev_web_port() {
  (
    set -a
    # shellcheck disable=SC1090 # path is only known at runtime
    . "$PRIMARY_ENV" >/dev/null 2>&1 || true
    set +a
    echo "${EXPOSE_PORT_WEB_DEV:-4173}"
  )
}

start_dev_web() {
  local port="$1" waited=0

  if curl -sf -o /dev/null "http://localhost:$port/"; then
    echo "Vite dev server already running on port $port — using it."
    return 0
  fi

  mkdir -p "$(dirname "$DEV_WEB_LOG")"
  echo "Starting Vite dev server on port $port (logs: $DEV_WEB_LOG)..."
  npm run dev --workspace apps/frontend/tcp-frontend >"$DEV_WEB_LOG" 2>&1 &
  echo $! >"$DEV_WEB_PID_FILE"

  # Vite binds in a second or two; 30 is slack for a cold dependency
  # optimisation pass, not an expectation.
  until curl -sf -o /dev/null "http://localhost:$port/"; do
    if (( waited >= 30 )); then
      echo "ERROR: Vite dev server did not answer on port $port within ${waited}s." >&2
      echo "Last lines of $DEV_WEB_LOG:" >&2
      tail -20 "$DEV_WEB_LOG" >&2 || true
      stop_dev_web
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "Vite dev server is up."
}

# Kill the npm wrapper and the vite process it spawned. Children first: killing
# the parent alone reparents vite and leaves the port held, which then looks
# like "already running" on the next start.
stop_dev_web() {
  [[ -f "$DEV_WEB_PID_FILE" ]] || return 0
  local pid
  pid="$(cat "$DEV_WEB_PID_FILE")"
  pkill -P "$pid" 2>/dev/null || true
  kill "$pid" 2>/dev/null || true
  rm -f "$DEV_WEB_PID_FILE"
}

# Reads VAR from env_file's gitignored ".local" override (where
# start-deployment.sh's bootstrap writes generated values), falling back to
# the committed base file. Echoes the value and returns 0, or returns 1 if
# neither file sets it — the one place this cascade is written, instead of
# repeating the same two-file loop for every variable that needs it.
read_env_var() {
  local var="$1" env_file="$2" candidate value
  for candidate in "$env_file.local" "$env_file"; do
    [[ -f "$candidate" ]] || continue
    value="$(grep -m1 "^${var}=" "$candidate" | cut -d= -f2-)"
    if [[ -n "$value" ]]; then
      echo "$value"
      return 0
    fi
  done
  return 1
}

# Obtains a token via the client_credentials grant against Zitadel directly,
# using the machine test user start-deployment.sh's own Zitadel bootstrap
# creates (see TEST_CLIENT_ID/TEST_CLIENT_SECRET there) — the same grant
# apps/backend/test/api/helpers/ApiHelper.ts and the browser tier use.
# get-token's device-flow login needs a human in a browser, which --reset,
# running unattended, cannot assume.
get_machine_token() {
  local env_file="$1"
  local client_id client_secret issuer
  client_id="$(read_env_var TEST_CLIENT_ID "$env_file")" || client_id=""
  client_secret="$(read_env_var TEST_CLIENT_SECRET "$env_file")" || client_secret=""
  issuer="$(read_env_var OIDC_ISSUER_URL "$env_file")" || issuer="http://localhost:8080"

  if [[ -z "$client_id" || -z "$client_secret" ]]; then
    echo "ERROR: TEST_CLIENT_ID/TEST_CLIENT_SECRET not found in $env_file(.local) — the Zitadel bootstrap above should have written them." >&2
    return 1
  fi

  local token_endpoint
  token_endpoint="$(curl -sf "$issuer/.well-known/openid-configuration" | jq -r '.token_endpoint')"
  if [[ -z "$token_endpoint" || "$token_endpoint" == "null" ]]; then
    echo "ERROR: could not read token_endpoint from $issuer/.well-known/openid-configuration" >&2
    return 1
  fi

  curl -sf -X POST "$token_endpoint" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode "grant_type=client_credentials" \
    --data-urlencode "client_id=$client_id" \
    --data-urlencode "client_secret=$client_secret" \
    --data-urlencode "scope=openid profile" \
    | jq -r '.access_token'
}

# Looks up the human test user's Zitadel id — the `sub` claim its own
# device-flow login carries — via the admin PAT start-deployment.sh's
# Zitadel bootstrap just (re)wrote. Reused rather than minting a second
# admin credential of our own. The PAT lives outside any Docker volume
# (docker/zitadel-machinekey/), so --reset's volume wipe doesn't touch it —
# only a genuinely fresh Zitadel instance (which --reset always produces)
# rewrites it, which is exactly when we need the new one.
#
# get-token's own device-flow scope (auth-token.service.ts) is
# `openid profile offline_access`, with no `email` — so this human user's
# JWT never carries an `email` claim to key a CompanyUser row on. `sub` is
# the only identifier form guaranteed present.
lookup_test_user_id() {
  local username="$1"
  local pat_file="$REPO_ROOT/docker/zitadel-machinekey/tcp-dev/pat.txt"
  if [[ ! -s "$pat_file" ]]; then
    echo "ERROR: no Zitadel bootstrap PAT at $pat_file" >&2
    return 1
  fi
  local pat
  pat="$(cat "$pat_file")"
  curl -sf "http://localhost:8080/management/v1/users/_search" \
    -H "Authorization: Bearer $pat" \
    -H 'Content-Type: application/json' \
    -d "$(jq -n --arg u "$username" '{queries:[{userNameQuery:{userName:$u,method:"TEXT_QUERY_METHOD_EQUALS"}}]}')" \
    | jq -r '.result[0].id // empty'
}

# Adds the human test user as an `owner` of a seeded company. `set-company`
# makes its CALLER the creator, and the caller here is the machine test user
# (client_credentials — no human in a browser to drive get-token's device
# flow), so without this a seeded company is invisible to the human test
# user until someone adds them by hand. There's no tcp-cli verb for company
# membership, so this calls the REST endpoint directly; the machine user is
# in TCP_ADMIN_IDENTIFIERS, which is what lets it add a member to a company
# it created but the human user hasn't joined yet.
add_test_user_membership() {
  local token="$1" tcp_server_url="$2" company_id="$3" test_user_id="$4"
  curl -sf -X POST "$tcp_server_url/api/company/$company_id/users" \
    -H "Authorization: Bearer $token" \
    -H 'Content-Type: application/json' \
    -d "$(jq -n --arg id "$test_user_id" '{identifier: $id, memberType: "owner"}')" \
    >/dev/null
}

# --reset's seed data: two small companies to poke at right after a fresh
# start, rather than an empty "you are not a member of any company" screen.
# Only ever called against a database --reset just wiped, so every
# `set-company`/`set-role` below is a create (no --company-id/--role-id given
# and the JSON carries no `id`) — safe here, but NOT safe to call again
# without wiping first, since a second create would collide on the slug.
seed_test_companies() {
  echo "Setting up test companies..."

  local token
  if ! token="$(get_machine_token "$PRIMARY_ENV")" || [[ -z "$token" || "$token" == "null" ]]; then
    echo "ERROR: could not obtain a machine token — skipping test company setup." >&2
    echo "  Set it up by hand: ./tcp-cli.sh get-token, then set-company/set-role/store-knowledge." >&2
    return 1
  fi

  # tcp-cli's own --tcp-server default is a literal localhost:3000 — wrong
  # for any env file (.env.testing exposes tcp-server on 3001) other than
  # the one that happens to match it. Read the real port and pass it
  # explicitly, always as the long --tcp-server form: store-knowledge
  # defines its own -s/--source, which collides with the short global
  # -s/--tcp-server and silently drops whichever one loses — using the long
  # form everywhere keeps every call the same, not just the one that needs it.
  local expose_port_api tcp_server_url
  expose_port_api="$(read_env_var EXPOSE_PORT_API "$PRIMARY_ENV")" || expose_port_api=3000
  tcp_server_url="http://localhost:$expose_port_api"

  local test_username test_user_id
  test_username="$(read_env_var TEST_USERNAME "$PRIMARY_ENV")" || test_username="test"
  if ! test_user_id="$(lookup_test_user_id "$test_username")" || [[ -z "$test_user_id" ]]; then
    echo "ERROR: could not look up the human test user ($test_username) in Zitadel — companies will be created but not shared with it." >&2
    test_user_id=""
  fi

  local cli="$REPO_ROOT/tcp-cli.sh"
  local data="$REPO_ROOT/scripts/test-data"

  # The company's own id and slug are read back from what the server
  # actually created rather than assumed from the JSON filename —
  # scripts/test-data/companies/simple-company.json's `slug` field is
  # "test-company", not "simple-company".
  local hm_company hm_id hm_slug
  hm_company="$("$cli" -t "$token" --tcp-server "$tcp_server_url" set-company < "$data/companies/home-maintenance.json")"
  hm_id="$(jq -r '.id' <<< "$hm_company")"
  hm_slug="$(jq -r '.slug' <<< "$hm_company")"
  echo "  Company: $hm_slug"
  "$cli" -t "$token" --tcp-server "$tcp_server_url" set-role --company-slug "$hm_slug" \
    < "$data/roles/diy-assistant.json" >/dev/null
  echo "    Role: diy-assistant"
  "$cli" -t "$token" --tcp-server "$tcp_server_url" store-knowledge \
    --company-slug "$hm_slug" --role diy-assistant \
    --source "$data/knowledge/diy-manual.pdf" >/dev/null
  echo "    Knowledge: diy-manual.pdf"
  if [[ -n "$test_user_id" ]]; then
    add_test_user_membership "$token" "$tcp_server_url" "$hm_id" "$test_user_id"
    echo "    Shared with: $test_username"
  fi

  local simple_company simple_id simple_slug
  simple_company="$("$cli" -t "$token" --tcp-server "$tcp_server_url" set-company < "$data/companies/simple-company.json")"
  simple_id="$(jq -r '.id' <<< "$simple_company")"
  simple_slug="$(jq -r '.slug' <<< "$simple_company")"
  echo "  Company: $simple_slug"
  "$cli" -t "$token" --tcp-server "$tcp_server_url" set-role --company-slug "$simple_slug" \
    < "$data/roles/chicken-assistant.json" >/dev/null
  echo "    Role: chicken-assistant"
  "$cli" -t "$token" --tcp-server "$tcp_server_url" set-role --company-slug "$simple_slug" \
    < "$data/roles/cat-assistant.json" >/dev/null
  echo "    Role: cat-assistant"
  if [[ -n "$test_user_id" ]]; then
    add_test_user_membership "$token" "$tcp_server_url" "$simple_id" "$test_user_id"
    echo "    Shared with: $test_username"
  fi

  echo ""
}

if [[ "$DEV_WEB" == true ]]; then
  DEV_WEB_PORT="$(read_dev_web_port)"
  start_dev_web "$DEV_WEB_PORT"
  ARGS+=(--dev-web)
fi

# Not `exec`: the closing note below has to outlive start-deployment.sh, and a
# failed start must not leave an orphaned dev server behind.
if ! "$REPO_ROOT/scripts/start-deployment.sh" "${ARGS[@]}"; then
  status=$?
  [[ "$DEV_WEB" == true ]] && stop_dev_web
  exit "$status"
fi

if [[ "$RESET" == true ]]; then
  seed_test_companies
fi

if [[ "$DEV_WEB" == true ]]; then
  echo "Web client: Vite dev server (HMR), proxied by tcp-web."
  echo "  Logs:  $DEV_WEB_LOG"
  echo "  Stop:  ./scripts/stop-dev.sh  (stops the dev server too)"
else
  echo "Web client: the built bundle — a production build."
  echo "  Development-only capabilities are compiled out of it, so ?devSession="
  echo "  and anything like it will not work here. Restart with --dev-web for"
  echo "  those, and for HMR. See docs/web-client.md."
fi
echo ""
