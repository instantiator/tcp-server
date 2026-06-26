import { EmbeddingService, EpisodicMemory, LcpCompany } from '@lcp/shared';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditClientService } from '../audit/audit-client.service';
import { McpController } from './mcp.controller';
import { MemoryToolsService } from './memory-tools.service';

/** Wires the MCP controller and memory tools service. */
@Module({
  imports: [TypeOrmModule.forFeature([LcpCompany, EpisodicMemory])],
  controllers: [McpController],
  providers: [MemoryToolsService, EmbeddingService, AuditClientService],
})
export class McpModule {}
