#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $(basename "$0") [-h|--help] [--base-url URL] [-- <playwright options>]

Run the browser test suite against a running TCP web deployment.

Like the api and smoke tiers, this is a black-box client: it drives whatever is
serving at --base-url and provisions nothing itself (ADR-016). It defaults to
http://localhost:4173, which is where 'vite preview' serves the built bundle.

  npm run build --workspace apps/frontend/tcp-frontend
  $(basename "$0")

Until 002.03 puts the web app behind nginx in the deployment, nothing in the
compose stack serves it — so the Playwright config starts 'vite preview' itself
when nothing already answers on the base URL. Once the deployment serves the
app, point this at it and that fallback goes unused:

  $(basename "$0") --base-url http://localhost:5173

Browser binaries are large and are NOT installed by 'npm ci' — contributors who
never run this script never download them. This script installs Chromium on
first use.

Any extra arguments after -- are passed through to Playwright, for example:
  $(basename "$0") -- --headed
  $(basename "$0") -- --grep "heading"

Options:
  --base-url URL   Web app base URL (default: http://localhost:4173)
  -h, --help       Show this help message and exit

--base-url can also be supplied as TCP_WEB_URL; the flag takes precedence.
EOF
}

BASE_URL="${TCP_WEB_URL:-http://localhost:4173}"
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
