import { AuditEvent, LcpAgent, LcpCompany, LcpRole } from '@lcp/shared';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentLoopService } from '../agent/agent-loop.service';
import { McpClientModule } from '../mcp/mcp-client.module';
import { AgentRagModule } from '../rag/agent-rag.module';
import { AgentRegistryService } from '../registry/agent-registry.service';
import { AgentWorkerService } from './agent-worker.service';

/**
 * Wires the BullMQ worker, the agent loop, and the in-memory registry
 * together. TypeORM repositories for the entities touched by the loop are
 * registered here so they are available via DI.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([LcpAgent, LcpRole, LcpCompany, AuditEvent]),
    AgentRagModule,
    McpClientModule,
  ],
  providers: [AgentWorkerService, AgentLoopService, AgentRegistryService],
})
export class AgentWorkerModule {}
