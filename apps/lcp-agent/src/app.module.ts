import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { configSchema } from './config/config.schema';
import { HealthModule } from './health/health.module';

/**
 * Root module for lcp-agent. Wires global config validation and
 * the health check endpoint. Agent loop workers are added here as they
 * are implemented.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: configSchema,
      validationOptions: { abortEarly: true },
    }),
    HealthModule,
  ],
})
export class AppModule {}
