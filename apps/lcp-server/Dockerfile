FROM node:26-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build lcp-server

FROM node:26-alpine
WORKDIR /app
RUN apk add --no-cache curl
# Webpack bundles everything into dist/apps/lcp-server/main.js.
# After this COPY: dist/main.js is the entry point.
COPY --from=builder /app/dist/apps/lcp-server ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3000
CMD ["node", "dist/main.js"]
