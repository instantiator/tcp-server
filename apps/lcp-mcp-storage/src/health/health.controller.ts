import { Controller, Get } from '@nestjs/common';

/**
 * Exposes `GET /health` for liveness checks.
 *
 * Since docs/prompts/009.4, this service no longer talks to MinIO directly —
 * it proxies all storage actions to lcp-server's `/internal/storage/*`
 * endpoints, so it has no direct infrastructure dependency left to check.
 * Its runtime dependency (lcp-server) is guaranteed healthy before this
 * service starts by Docker Compose `depends_on: condition: service_healthy`.
 * Probing lcp-server here would add no information and would create a
 * circular health dependency chain (lcp-server doesn't probe downstream
 * services either — see docs/database.md's cross-service-communication
 * section). Cross-service communication health is validated by the smoke
 * test suite instead.
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: string } {
    return { status: 'ok' };
  }
}
