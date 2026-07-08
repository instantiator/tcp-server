import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { StorageCheckController } from './storage-check.controller';
import { StorageToolsService } from './storage-tools.service';

/**
 * Wires the MCP controller and storage tools. `StorageToolsService` is a
 * thin HTTP proxy to lcp-server's `/internal/storage/*` endpoints — no
 * audit client needed here, lcp-server records the audit event itself.
 */
@Module({
  controllers: [McpController, StorageCheckController],
  providers: [StorageToolsService],
})
export class McpModule {}
