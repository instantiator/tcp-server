FROM node:26-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build lcp-agent

FROM node:26-alpine
WORKDIR /app
RUN apk add --no-cache curl
# lcp-agent has no @lcp/shared imports, so tsc rootDir stays as apps/lcp-agent/src/.
# Output lands directly at dist/apps/lcp-agent/main.js (no src/ prefix).
COPY --from=builder /app/dist/apps/lcp-agent ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3001
CMD ["node", "dist/main.js"]
