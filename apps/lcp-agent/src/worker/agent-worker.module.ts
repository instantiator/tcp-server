import { LcpAgent, LcpCompany, LcpRole } from '@lcp/shared';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentLoopService } from '../agent/agent-loop.service';
import { AuditClientService } from '@lcp/shared';
import { McpClientModule } from '../mcp/mcp-client.module';
import { AgentRagModule } from '../rag/agent-rag.module';
import { AgentRegistryService } from '../registry/agent-registry.service';
import { StorageTrackingClientService } from '../storage-tracking/storage-tracking-client.service';
import { AgentWorkerService } from './agent-worker.service';

/**
 * Wires the BullMQ worker, the agent loop, and the in-memory registry
 * together. TypeORM repositories for the entities touched by the loop are
 * registered here so they are available via DI.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([LcpAgent, LcpRole, LcpCompany]),
    AgentRagModule,
    McpClientModule,
  ],
  providers: [
    AgentWorkerService,
    AgentLoopService,
    AgentRegistryService,
    AuditClientService,
    StorageTrackingClientService,
  ],
})
export class AgentWorkerModule {}
