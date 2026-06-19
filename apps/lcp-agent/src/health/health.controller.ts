import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';

/**
 * Exposes `GET /health` to report the liveness of lcp-agent.
 * Additional dependency checks (database, Redis) will be added here
 * when lcp-agent gains those connections.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthCheckService) {}

  /**
   * Runs health checks and returns HTTP 200 when all pass, 503 when any fail.
   * TODO: add TypeORM and Redis indicators when lcp-agent gains a database or Redis connection.
   */
  @Get()
  @HealthCheck()
  check() {
    return this.health.check([]);
  }
}
