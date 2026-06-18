import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HttpHealthIndicator,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { ConfigService } from '@nestjs/config';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly http: HttpHealthIndicator,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    const minioEndpoint = this.config.get<string>('MINIO_ENDPOINT') ?? '';
    return this.health.check([
      () => this.db.pingCheck('database'),
      () =>
        this.http.pingCheck(
          'minio',
          `${minioEndpoint}/minio/health/live`,
        ),
    ]);
  }
}
