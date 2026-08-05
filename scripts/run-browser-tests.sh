#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") [-h|--help] [--base-url URL] [-- <playwright options>]

Run the browser test suite against a running TCP web deployment.

Like the api and smoke tiers, this is a black-box client: it drives whatever is
serving at --base-url and provisions nothing itself (ADR-016). The deployment's
tcp-web service serves the app, so start a stack first:

  ./scripts/start-deployment.sh --project tcp-dev --env-file .env.dev
  $(basename "$0")

The URL is https, not http. The web service is TLS-only because HTTP/2 is a
requirement (ADR-025) and no browser negotiates HTTP/2 over cleartext. The
container's certificate is self-signed unless you mount your own, so Playwright
is configured to accept it — see docs/web-client.md for the mkcert route.

Point it at another stack with --base-url, for example the testing project on
EXPOSE_PORT_WEB=5174:

  $(basename "$0") --base-url https://localhost:5174

Browser binaries are large and are NOT installed by 'npm ci' — contributors who
never run this script never download them. This script installs Chromium on
first use.

Any extra arguments after -- are passed through to Playwright, for example:
  $(basename "$0") -- --headed
  $(basename "$0") -- --grep "heading"

Options:
  --base-url URL   Web app base URL (default: https://localhost:\${EXPOSE_PORT_WEB:-5173})
  -h, --help       Show this help message and exit

--base-url can also be supplied as TCP_WEB_URL; the flag takes precedence.
EOF
}

BASE_URL="${TCP_WEB_URL:-https://localhost:${EXPOSE_PORT_WEB:-5173}}"
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
FRONTEND="$REPO_ROOT/apps/frontend/tcp-frontend"

# Playwright is a no-op if the browser is already present, so this is cheap on
# every run after the first. --with-deps needs root on Linux and is a no-op on
# macOS, so it is left to CI, which sets it explicitly.
npm --prefix "$FRONTEND" exec -- playwright install chromium

export TCP_WEB_URL="$BASE_URL"

npm --prefix "$REPO_ROOT" run test:browser -- ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}
