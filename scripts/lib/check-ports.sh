#!/usr/bin/env bash
# lib/check-ports.sh — Verify that EXPOSE_PORT_* ports are available.

# Checks that the required exposed ports are not already in use.
# Exits with error if any port is already listening.
check_exposed_ports() {
  local ports=("${EXPOSE_PORT_API:-3000}" "${EXPOSE_PORT_DB:-5432}" "${EXPOSE_PORT_MINIO:-9000}" "${EXPOSE_PORT_ZITADEL:-8080}" "${EXPOSE_PORT_WEB:-5173}")
  local in_use=()
  for port in "${ports[@]}"; do
    if lsof -i :"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      in_use+=("$port")
    fi
  done
  if [[ ${#in_use[@]} -gt 0 ]]; then
    echo "Error: the following ports are already in use:" >&2
    for port in "${in_use[@]}"; do
      echo "  port $port — check: lsof -i :$port" >&2
    done
    echo "Often that's another TCP stack: list them with 'docker compose ls' and stop one" >&2
    echo "with ./scripts/stop-dev.sh --project <name>. Or give this one different ports" >&2
    echo "(EXPOSE_PORT_*) in its env file." >&2
    exit 1
  fi
}
