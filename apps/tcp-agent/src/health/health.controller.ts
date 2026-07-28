import { assertRedisReachable } from '@tcp/shared';
import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorResult,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';

/**
 * Exposes `GET /health` to report the liveness of tcp-agent's dependencies:
 * PostgreSQL (via TypeORM) and Redis (via a ping command).
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly config: ConfigService,
  ) {}

  /**
   * Runs health checks for the database and Redis queue.
   * Returns HTTP 200 when all pass, 503 when any fail.
   */
  @Get()
  @HealthCheck()
  async check(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.db.pingCheck('database'),
      () => this.pingRedis(),
    ]);
  }

  private async pingRedis(): Promise<HealthIndicatorResult> {
    const url = this.config.getOrThrow<string>('REDIS_URL');
    try {
      await assertRedisReachable(url);
      return { redis: { status: 'up' } };
    } catch (err) {
      return {
        redis: {
          status: 'down',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}
