import { Module } from '@nestjs/common';
import { McpClientService } from '@tcp/shared';

/** Provides {@link McpClientService} to any module that imports this one. */
@Module({ providers: [McpClientService], exports: [McpClientService] })
export class McpClientModule {}
