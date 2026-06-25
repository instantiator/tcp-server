import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  HttpHealthIndicator,
} from '@nestjs/terminus';

/**
 * Exposes `GET /health` to report liveness of lcp-mcp-storage's dependencies.
 * Returns HTTP 200 when all pass, 503 when any fail.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly http: HttpHealthIndicator,
    private readonly config: ConfigService,
  ) {}

  /** Checks that the MinIO object store is reachable. */
  @Get()
  @HealthCheck()
  check(): Promise<HealthCheckResult> {
    const endpoint =
      this.config.get<string>('MINIO_ENDPOINT') ?? 'http://localhost:9000';
    return this.health.check([
      () => this.http.pingCheck('minio', `${endpoint}/minio/health/live`),
    ]);
  }
}
