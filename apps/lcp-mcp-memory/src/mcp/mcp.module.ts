import {
  EmbeddingService,
  EpisodicMemory,
  LcpCompany,
  AuditClientService,
} from '@lcp/shared';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { McpController } from './mcp.controller';
import { MemoryToolsService } from './memory-tools.service';

/** Wires the MCP controller and memory tools service. */
@Module({
  imports: [TypeOrmModule.forFeature([LcpCompany, EpisodicMemory])],
  controllers: [McpController],
  providers: [MemoryToolsService, EmbeddingService, AuditClientService],
})
export class McpModule {}
