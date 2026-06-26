FROM node:26-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build lcp-mcp-interactions

FROM node:26-alpine
WORKDIR /app
RUN apk add --no-cache curl
COPY --from=builder /app/dist/apps/lcp-mcp-interactions ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3012
CMD ["node", "dist/main.js"]
