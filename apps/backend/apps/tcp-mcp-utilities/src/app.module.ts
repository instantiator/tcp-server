import { StaticHealthModule, mcpConfigModule } from '@tcp/shared';
import { Module } from '@nestjs/common';
import { McpModule } from './mcp/mcp.module';

/** Root module for tcp-mcp-utilities. Stateless: config, health, and MCP tooling only. */
@Module({
  imports: [
    mcpConfigModule(),
    StaticHealthModule.forService('tcp-mcp-utilities'),
    McpModule,
  ],
})
export class AppModule {}
