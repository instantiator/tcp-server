import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { UtilitiesToolsService } from './utilities-tools.service';

/** Wires the MCP controller and utilities tools service. */
@Module({
  controllers: [McpController],
  providers: [UtilitiesToolsService],
})
export class McpModule {}
