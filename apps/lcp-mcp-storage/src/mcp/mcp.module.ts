import { Module } from '@nestjs/common';
import { AuditClientService } from '../audit/audit-client.service';
import { McpController } from './mcp.controller';
import { StorageToolsService } from './storage-tools.service';

/** Wires the MCP controller, storage tools, and audit client. */
@Module({
  controllers: [McpController],
  providers: [StorageToolsService, AuditClientService],
})
export class McpModule {}
