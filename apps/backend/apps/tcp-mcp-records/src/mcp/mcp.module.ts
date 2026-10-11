import {
  AuditClientService,
  InternalApiClient,
  RecordsService,
} from '@tcp/shared';
import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { RecordsToolsService } from './records-tools.service';

/** Wires the MCP controller, the records tools and the audit client. */
@Module({
  controllers: [McpController],
  providers: [
    RecordsToolsService,
    RecordsService,
    AuditClientService,
    InternalApiClient,
  ],
})
export class McpModule {}
