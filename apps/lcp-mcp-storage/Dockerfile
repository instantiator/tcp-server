FROM node:26-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build lcp-mcp-storage

FROM node:26-alpine
WORKDIR /app
RUN apk add --no-cache curl
COPY --from=builder /app/dist/apps/lcp-mcp-storage ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3010
CMD ["node", "dist/main.js"]
