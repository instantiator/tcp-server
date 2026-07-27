# syntax=docker/dockerfile:1
#
# Single multi-stage build for the whole monorepo. Replaces the six near-identical
# per-app Dockerfiles (apps/*/Dockerfile), which each ran `npm ci` and built ALL
# apps — `npm run build <app>` expands to `build:apps && schema:generate &&
# licenses:generate`, so every image rebuilt all 7 apps plus schema/licence
# generation. Here the shared `builder` and `prod-deps` stages run ONCE and are
# reused across every service target (docker-compose/buildx bake shares common
# stages within a build), and each service's final stage only copies its own
# `dist/` and prod-only `node_modules`.
#
# Each service's compose entry selects its final stage via `target:` (e.g.
# `target: tcp-server`). Build a single service directly with:
#   docker build --target tcp-mcp-storage -t tcp-mcp-storage:latest .

# ---- Shared builder: install once, build every app once --------------------
FROM node:26-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
# build:apps runs the nest/webpack build for every app (no schema/licence steps).
RUN npm run build:apps

# ---- Shared production dependencies (no devDependencies) --------------------
FROM node:26-alpine AS prod-deps
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# ---- Per-service runtime images --------------------------------------------
# Webpack bundles each app into dist/apps/<app>/main.js; after the COPY it sits
# at ./dist/main.js. curl is present for the compose healthchecks.

FROM node:26-alpine AS tcp-server
WORKDIR /app
RUN apk add --no-cache curl
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist/apps/tcp-server ./dist
EXPOSE 3000
CMD ["node", "dist/main.js"]

FROM node:26-alpine AS tcp-agent
WORKDIR /app
RUN apk add --no-cache curl
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist/apps/tcp-agent ./dist
EXPOSE 3001
CMD ["node", "dist/main.js"]

FROM node:26-alpine AS tcp-mcp-storage
WORKDIR /app
RUN apk add --no-cache curl
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist/apps/tcp-mcp-storage ./dist
EXPOSE 3010
CMD ["node", "dist/main.js"]

FROM node:26-alpine AS tcp-mcp-memory
WORKDIR /app
RUN apk add --no-cache curl
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist/apps/tcp-mcp-memory ./dist
EXPOSE 3011
CMD ["node", "dist/main.js"]

FROM node:26-alpine AS tcp-mcp-interactions
WORKDIR /app
RUN apk add --no-cache curl
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist/apps/tcp-mcp-interactions ./dist
EXPOSE 3012
CMD ["node", "dist/main.js"]

FROM node:26-alpine AS tcp-mcp-tasks
WORKDIR /app
RUN apk add --no-cache curl
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist/apps/tcp-mcp-tasks ./dist
EXPOSE 3013
CMD ["node", "dist/main.js"]
