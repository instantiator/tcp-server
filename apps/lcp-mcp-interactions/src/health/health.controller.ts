import { Controller, Get } from '@nestjs/common';

/**
 * Exposes `GET /health` for liveness checks.
 *
 * This service has no direct infrastructure dependencies (no database, no
 * Redis, no MinIO). Its runtime dependencies — lcp-server and lcp-mcp-storage
 * — are guaranteed to be healthy before this service starts by Docker Compose
 * `depends_on: condition: service_healthy`. Probing them here would add no
 * information and would create a circular health dependency chain (lcp-server
 * also probes its own infra, not downstream services). Cross-service
 * communication health is validated by the smoke test suite instead.
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: string } {
    return { status: 'ok' };
  }
}
