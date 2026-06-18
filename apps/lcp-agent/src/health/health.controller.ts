import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthCheckService) {}

  @Get()
  @HealthCheck()
  check() {
    // ponytail: no DB indicator yet — lcp-agent doesn't use TypeORM in this stub phase
    return this.health.check([]);
  }
}
