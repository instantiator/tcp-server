import {
  AuditClientService,
  InternalApiClient,
  RecordsService,
} from '@tcp/shared';
import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { RecordsInternalController } from './records-internal.controller';
import { RecordsToolsService } from './records-tools.service';

/** Wires the MCP and internal controllers, the records tools and the audit client. */
@Module({
  controllers: [McpController, RecordsInternalController],
  providers: [
    RecordsToolsService,
    RecordsService,
    AuditClientService,
    InternalApiClient,
  ],
})
export class McpModule {}
