import { StaticHealthModule, mcpConfigModule } from '@tcp/shared';
import { Module } from '@nestjs/common';
import { McpModule } from './mcp/mcp.module';

/** Root module for tcp-mcp-storage. Wires config, health, and MCP tooling. */
@Module({
  imports: [
    mcpConfigModule(),
    StaticHealthModule.forService('tcp-mcp-storage'),
    McpModule,
  ],
})
export class AppModule {}
