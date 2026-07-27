import { McpClientService } from '@tcp/shared';
import { Module } from '@nestjs/common';

/** Provides {@link McpClientService} for MCP tool loading within lcp-server. */
@Module({ providers: [McpClientService], exports: [McpClientService] })
export class McpClientModule {}
