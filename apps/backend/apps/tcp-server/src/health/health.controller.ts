import { setHealthRefresh } from '@tcp/shared';
import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthCheck } from '@nestjs/terminus';
import { ServerHealthService } from './server-health.service';

/**
 * Exposes `GET /health` to report the liveness of tcp-server's dependencies:
 * PostgreSQL, Redis, MinIO, and the OIDC provider.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly serverHealth: ServerHealthService) {}

  /**
   * Runs health checks against the database, Redis, MinIO, and the OIDC
   * provider. Returns HTTP 200 when all checks pass, 503 when any fail.
   */
  @Get()
  @HealthCheck()
  check(@Res({ passthrough: true }) res: Response) {
    setHealthRefresh(res);
    return this.serverHealth.check();
  }
}
