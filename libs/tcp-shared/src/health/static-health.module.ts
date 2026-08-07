import { Controller, Get, Module } from '@nestjs/common';

/**
 * Exposes `GET /health` for liveness checks on services with no direct
 * infrastructure dependency of their own.
 *
 * These services proxy their work to tcp-server's `/internal/*` endpoints, and
 * Docker Compose already guarantees tcp-server is healthy before they start
 * (`depends_on: condition: service_healthy`). Probing tcp-server from here
 * would add no information and would create a circular health dependency —
 * tcp-server does not probe downstream services either (see docs/database.md's
 * cross-service-communication section). The smoke suite validates the
 * cross-service path instead.
 */
@Controller('health')
export class StaticHealthController {
  @Get()
  check(): { status: string } {
    return { status: 'ok' };
  }
}

/**
 * Ready-made liveness endpoint for MCP services with no infrastructure
 * dependency to probe. Services that do have one — tcp-mcp-memory, which pings
 * PostgreSQL via Terminus — declare their own health module instead.
 */
@Module({ controllers: [StaticHealthController] })
export class StaticHealthModule {}
