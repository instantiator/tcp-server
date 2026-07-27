import { Module } from '@nestjs/common';
import { AuditClientService } from '@tcp/shared';
import { McpController } from './mcp.controller';
import { TasksToolsService } from './tasks-tools.service';

/** Wires the MCP controller, tasks tools, and audit client. */
@Module({
  controllers: [McpController],
  providers: [TasksToolsService, AuditClientService],
})
export class McpModule {}
