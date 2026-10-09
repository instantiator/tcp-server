import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HttpModule } from '@nestjs/axios';
import { HealthController } from './health.controller';
import { ServerHealthService } from './server-health.service';

/**
 * Exposes the {@link HealthController}, and exports tcp-server's own checks
 * for the combined system health report.
 */
@Module({
  imports: [TerminusModule, HttpModule],
  controllers: [HealthController],
  providers: [ServerHealthService],
  exports: [ServerHealthService],
})
export class HealthModule {}
