import { InternalApiClient } from '@tcp/shared';
import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { StorageToolsService } from './storage-tools.service';

/**
 * Wires the MCP controller and storage tools. `StorageToolsService` is a
 * thin HTTP proxy to tcp-server's `/internal/storage/*` endpoints — no
 * audit client needed here, tcp-server records the audit event itself.
 */
@Module({
  controllers: [McpController],
  providers: [StorageToolsService, InternalApiClient],
})
export class McpModule {}
