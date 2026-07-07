import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/** Exposes the {@link HealthController} for liveness checks. */
@Module({ controllers: [HealthController] })
export class HealthModule {}
