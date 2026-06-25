import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { configSchema } from './config/config.schema';
import { HealthModule } from './health/health.module';
import { McpModule } from './mcp/mcp.module';

/** Root module for lcp-mcp-interactions. Wires config validation, health, and MCP tooling. */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: configSchema,
      validationOptions: { abortEarly: true },
    }),
    HealthModule,
    McpModule,
  ],
})
export class AppModule {}
