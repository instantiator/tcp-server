#!/usr/bin/env bash
set -euo pipefail

docker compose up -d

echo "Waiting for lcp-server to be healthy..."
until curl -sf http://localhost:3000/health > /dev/null 2>&1; do sleep 3; done

echo "Waiting for lcp-agent to be healthy..."
until curl -sf http://localhost:3001/health > /dev/null 2>&1; do sleep 3; done

npm run test:system

docker compose down
