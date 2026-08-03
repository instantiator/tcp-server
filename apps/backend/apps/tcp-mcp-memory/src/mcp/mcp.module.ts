import {
  EmbeddingService,
  EpisodicMemory,
  InternalApiClient,
  KnowledgeRetrievalService,
  TcpCompany,
  TcpRole,
  AuditClientService,
} from '@tcp/shared';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { McpController } from './mcp.controller';
import { MemoryToolsService } from './memory-tools.service';

/** Wires the MCP controller and memory tools service. */
@Module({
  imports: [TypeOrmModule.forFeature([TcpCompany, TcpRole, EpisodicMemory])],
  controllers: [McpController],
  providers: [
    MemoryToolsService,
    EmbeddingService,
    KnowledgeRetrievalService,
    AuditClientService,
    InternalApiClient,
  ],
})
export class McpModule {}
