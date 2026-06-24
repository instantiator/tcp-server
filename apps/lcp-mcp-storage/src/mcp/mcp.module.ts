import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { StorageToolsService } from './storage-tools.service';

/** Wires the MCP controller and storage tools service. */
@Module({
  controllers: [McpController],
  providers: [StorageToolsService],
})
export class McpModule {}
