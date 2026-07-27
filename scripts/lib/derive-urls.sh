#!/usr/bin/env bash
# lib/derive-urls.sh — Derive host-facing URLs from EXPOSE_PORT_* and DB_* variables.

# Call after loading the env file to export DATABASE_URL, MINIO_ENDPOINT,
# OIDC_ISSUER_URL, and LCP_SERVER_URL for non-Docker usage (tests, CLI).
derive_host_urls() {
  export DATABASE_URL="postgres://${DB_USER:-tcp}:${DB_PASSWORD}@localhost:${EXPOSE_PORT_DB:-5432}/${DB_NAME:-tcp}"
  export MINIO_ENDPOINT="http://localhost:${EXPOSE_PORT_MINIO:-9000}"
  # OIDC_ISSUER_URL: use explicit value if set, else derive from Zitadel port
  export OIDC_ISSUER_URL="${OIDC_ISSUER_URL:-http://localhost:${EXPOSE_PORT_ZITADEL:-8080}}"
  export LCP_SERVER_URL="http://localhost:${EXPOSE_PORT_API:-3000}"
}
