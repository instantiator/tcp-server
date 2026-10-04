#!/usr/bin/env bash
# lib/machine-token.sh — Read env values written by start-deployment.sh's
# Zitadel bootstrap, and mint a client_credentials token against it, for
# scripts that need to call the API unattended (no human in a browser).

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

# The issuer as the host sees it — the same rule as derive_host_urls
# (scripts/lib/derive-urls.sh): an explicit OIDC_ISSUER_URL, else the bundled
# Zitadel on EXPOSE_PORT_ZITADEL. The wizard leaves OIDC_ISSUER_URL unset.
resolve_issuer() {
  read_env_var OIDC_ISSUER_URL "$1" \
    || echo "http://localhost:$(read_env_var EXPOSE_PORT_ZITADEL "$1" || echo 8080)"
}

# Obtains a token via the client_credentials grant against Zitadel directly,
# using the machine test user start-deployment.sh's own Zitadel bootstrap
# creates (see TEST_CLIENT_ID/TEST_CLIENT_SECRET there) — the same grant
# apps/backend/test/api/helpers/ApiHelper.ts and the browser tier use.
# get-token's device-flow login needs a human in a browser, which --seed,
# running unattended, cannot assume.
get_machine_token() {
  local env_file="$1"
  local client_id client_secret issuer
  client_id="$(read_env_var TEST_CLIENT_ID "$env_file")" || client_id=""
  client_secret="$(read_env_var TEST_CLIENT_SECRET "$env_file")" || client_secret=""
  issuer="$(resolve_issuer "$env_file")"

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
