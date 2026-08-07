import { InternalApiClient } from '@tcp/shared';
import { Module } from '@nestjs/common';
import { MaterialFileToolsService } from './material-file-tools.service';
import { McpController } from './mcp.controller';
import { SharedStorageToolsService } from './shared-storage-tools.service';
import { StorageApiService } from './storage-api.service';
import { StorageToolsService } from './storage-tools.service';
import { WorkingFileToolsService } from './working-file-tools.service';

/**
 * Wires the MCP controller and the three tiers of storage tools. All of them
 * are thin HTTP proxies to tcp-server's `/internal/storage/*` endpoints — no
 * audit client needed here, tcp-server records the audit event itself.
 */
@Module({
  controllers: [McpController],
  providers: [
    StorageToolsService,
    SharedStorageToolsService,
    WorkingFileToolsService,
    MaterialFileToolsService,
    StorageApiService,
    InternalApiClient,
  ],
})
export class McpModule {}
