import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './health/health.module';
import { McpModule } from './mcp/mcp.module';

/** Root module for lcp-mcp-memory. Wires config, health, and MCP tooling. */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), HealthModule, McpModule],
})
export class AppModule {}
