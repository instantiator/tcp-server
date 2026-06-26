FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build lcp-mcp-memory

FROM node:24-alpine
WORKDIR /app
RUN apk add --no-cache curl
COPY --from=builder /app/dist/apps/lcp-mcp-memory ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3011
CMD ["node", "dist/main.js"]
