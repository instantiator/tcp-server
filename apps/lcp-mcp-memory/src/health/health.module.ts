import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';

/** Exposes the {@link HealthController} for liveness checks. */
@Module({ imports: [TerminusModule], controllers: [HealthController] })
export class HealthModule {}
