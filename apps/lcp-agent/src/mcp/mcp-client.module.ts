import { Module } from '@nestjs/common';
import { McpClientService } from './mcp-client.service';

/** Provides {@link McpClientService} to any module that imports this one. */
@Module({ providers: [McpClientService], exports: [McpClientService] })
export class McpClientModule {}
