import { Module } from '@nestjs/common';
import { AuditClientService } from '@lcp/shared';
import { McpController } from './mcp.controller';
import { InteractionsToolsService } from './interactions-tools.service';

/** Wires the MCP controller, interactions tools, and audit client. */
@Module({
  controllers: [McpController],
  providers: [InteractionsToolsService, AuditClientService],
})
export class McpModule {}
