import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './health/health.module';
import { McpModule } from './mcp/mcp.module';

/** Root module for lcp-mcp-storage. Wires config, health, and MCP tooling. */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Prevents NestJS's own dotenv loading from independently reading the
      // real .env — see apps/lcp-server/src/app.module.ts for why.
      ignoreEnvFile: true,
    }),
    HealthModule,
    McpModule,
  ],
})
export class AppModule {}
