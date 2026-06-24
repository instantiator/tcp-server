import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { MemoryToolsService } from './memory-tools.service';

/** Wires the MCP controller and memory tools service. */
@Module({
  controllers: [McpController],
  providers: [MemoryToolsService],
})
export class McpModule {}
