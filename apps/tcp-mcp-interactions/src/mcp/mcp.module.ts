import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { InteractionsToolsService } from './interactions-tools.service';

/** Wires the MCP controller and interactions tools. */
@Module({
  controllers: [McpController],
  providers: [InteractionsToolsService],
})
export class McpModule {}
