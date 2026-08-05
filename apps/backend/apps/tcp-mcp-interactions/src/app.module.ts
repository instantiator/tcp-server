import { StaticHealthModule, mcpConfigModule } from '@tcp/shared';
import { Module } from '@nestjs/common';
import { configSchema } from './config/config.schema';
import { McpModule } from './mcp/mcp.module';

/** Root module for tcp-mcp-interactions. Wires config validation, health, and MCP tooling. */
@Module({
  imports: [
    mcpConfigModule(configSchema),
    StaticHealthModule.forService('tcp-mcp-interactions'),
    McpModule,
  ],
})
export class AppModule {}
