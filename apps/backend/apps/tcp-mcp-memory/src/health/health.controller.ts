import { serviceIdentity, setHealthRefresh } from '@tcp/shared';
import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';

/**
 * Exposes `GET /health` to report liveness of tcp-mcp-memory's dependencies.
 * Returns HTTP 200 when all pass, 503 when any fail.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
  ) {}

  /** Checks that the PostgreSQL connection is reachable. */
  @Get()
  @HealthCheck()
  check(@Res({ passthrough: true }) res: Response): Promise<HealthCheckResult> {
    setHealthRefresh(res);
    return this.health.check([
      // Names the responding service in both the 200 and the 503 body — see
      // `serviceIdentity`. First, so it heads the document.
      () => serviceIdentity('tcp-mcp-memory'),
      () => this.db.pingCheck('database'),
    ]);
  }
}
