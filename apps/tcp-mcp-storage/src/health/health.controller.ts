import { Controller, Get } from '@nestjs/common';

/**
 * Exposes `GET /health` for liveness checks.
 *
 * Since docs/prompts/009.4, this service no longer talks to MinIO directly —
 * it proxies all storage actions to tcp-server's `/internal/storage/*`
 * endpoints, so it has no direct infrastructure dependency left to check.
 * Its runtime dependency (tcp-server) is guaranteed healthy before this
 * service starts by Docker Compose `depends_on: condition: service_healthy`.
 * Probing tcp-server here would add no information and would create a
 * circular health dependency chain (tcp-server doesn't probe downstream
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
