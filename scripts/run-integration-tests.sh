#!/usr/bin/env bash
set -euo pipefail

docker compose up -d postgres redis minio

echo "Waiting for services to be healthy..."
until docker compose exec -T postgres pg_isready -U lcp 2>/dev/null; do sleep 2; done
until docker compose exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; do sleep 2; done
until curl -sf http://localhost:9000/minio/health/live 2>/dev/null; do sleep 2; done

export DATABASE_URL="postgres://lcp:${POSTGRES_PASSWORD:-dev-password}@localhost:5432/lcp"
export REDIS_URL="redis://localhost:6379"
export MINIO_ENDPOINT="http://localhost:9000"
export MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:-lcp-access-key}"
export MINIO_SECRET_KEY="${MINIO_SECRET_KEY:-lcp-secret-key}"

npm run test:integration

docker compose down
