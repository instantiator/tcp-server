# syntax=docker/dockerfile:1
#
# Zero runtime dependencies: `src/` is plain TypeScript run directly via
# Node's native type-stripping (stable since Node 23.6), so there is no
# npm install or build stage — just the source and a Node runtime.
FROM node:26-alpine
WORKDIR /app
RUN apk add --no-cache wget
COPY src ./src
COPY package.json ./
EXPOSE 3002
CMD ["node", "src/main.ts"]
