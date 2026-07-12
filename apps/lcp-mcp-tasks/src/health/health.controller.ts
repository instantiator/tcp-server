import { Controller, Get } from '@nestjs/common';

/**
 * Exposes `GET /health` for liveness checks.
 *
 * This service has no direct infrastructure dependencies (no database, no
 * Redis, no MinIO). Its only runtime dependency — lcp-server — is guaranteed
 * healthy before this service starts by Docker Compose `depends_on:
 * condition: service_healthy`. Probing it here would add no information and
 * would create a circular health dependency chain. Cross-service communication
 * health is validated by the smoke test suite instead.
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: string } {
    return { status: 'ok' };
  }
}
