import {
  AuditClientService,
  InternalApiClient,
  CONTEXT_AUDIT_SINK,
  ContextBudgetService,
  ContextCompactorService,
  ContextManagerService,
  IncomingDataGuardService,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
} from '@tcp/shared';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentEventPublisherService } from '../agent/agent-event-publisher.service';
import { AgentLoopService } from '../agent/agent-loop.service';
import { McpClientModule } from '../mcp/mcp-client.module';
import { AgentRagModule } from '../rag/agent-rag.module';
import { AgentRegistryService } from '../registry/agent-registry.service';
import { StorageTrackingClientService } from '../storage-tracking/storage-tracking-client.service';
import { AgentWorkerService } from './agent-worker.service';

/**
 * Wires the BullMQ worker, the agent loop, and the in-memory registry
 * together. TypeORM repositories for the entities touched by the loop are
 * registered here so they are available via DI.
 *
 * Also provides the shared {@link ContextManagerService} (context budget
 * checks + compaction) so worker runs get the same protection chat turns
 * already have — see {@link AgentLoopService}. No {@link OVERFLOW_STORE} is
 * bound here (no MinIO client in tcp-agent); the incoming-data guard simply
 * falls back to best-effort compaction when overflow storage is unavailable.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([TcpAgent, TcpRole, TcpCompany, TcpAssignment]),
    AgentRagModule,
    McpClientModule,
  ],
  providers: [
    AgentWorkerService,
    AgentLoopService,
    AgentEventPublisherService,
    AgentRegistryService,
    AuditClientService,
    InternalApiClient,
    StorageTrackingClientService,
    ContextBudgetService,
    ContextCompactorService,
    IncomingDataGuardService,
    { provide: CONTEXT_AUDIT_SINK, useExisting: AuditClientService },
    ContextManagerService,
  ],
})
export class AgentWorkerModule {}
