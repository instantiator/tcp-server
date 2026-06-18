FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build lcp-server

FROM node:24-alpine
WORKDIR /app
RUN apk add --no-cache curl
COPY --from=builder /app/dist/apps/lcp-server ./dist
COPY --from=builder /app/dist/libs ./dist/libs
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3000
# dist/apps/lcp-server/src/main.js reflects the tsc output structure
CMD ["node", "dist/apps/lcp-server/src/main.js"]
