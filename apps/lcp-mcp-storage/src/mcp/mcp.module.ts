import { Module } from '@nestjs/common';
import { AuditClientService } from '@lcp/shared';
import { McpController } from './mcp.controller';
import { StorageCheckController } from './storage-check.controller';
import { StorageToolsService } from './storage-tools.service';

/** Wires the MCP controller, storage tools, and audit client. */
@Module({
  controllers: [McpController, StorageCheckController],
  providers: [StorageToolsService, AuditClientService],
})
export class McpModule {}
