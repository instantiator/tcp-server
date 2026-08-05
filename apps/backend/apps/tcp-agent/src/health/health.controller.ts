import {
  assertRedisReachable,
  serviceIdentity,
  setHealthRefresh,
} from '@tcp/shared';
import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
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
  async check(
    @Res({ passthrough: true }) res: Response,
  ): Promise<HealthCheckResult> {
    setHealthRefresh(res);
    return this.health.check([
      // Names the responding service in both the 200 and the 503 body — see
      // `serviceIdentity`. First, so it heads the document.
      () => serviceIdentity('tcp-agent'),
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
