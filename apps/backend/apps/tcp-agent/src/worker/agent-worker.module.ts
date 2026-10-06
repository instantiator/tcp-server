import {
  AuditClientService,
  InternalApiClient,
  CONTEXT_AUDIT_SINK,
  ContextBudgetService,
  ContextCompactorService,
  ContextManagerService,
  IncomingDataGuardService,
  SpendCapState,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  TcpTask,
} from '@tcp/shared';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentEventPublisherService } from '../agent/agent-event-publisher.service';
import { AgentLoopService } from '../agent/agent-loop.service';
import { InitialStateService } from '../agent/initial-state.service';
import { AgentLoopEventRecorder } from '../agent/loop-events.service';
import { AgentRunEnvironmentService } from '../agent/run-environment.service';
import { AgentRunStatusService } from '../agent/run-status.service';
import { SpendGateService } from '../agent/spend-gate.service';
import { SupervisedTurnService } from '../agent/supervised-turn.service';
import { McpClientModule } from '../mcp/mcp-client.module';
import { AgentRagModule } from '../rag/agent-rag.module';
import { AgentRegistryService } from '../registry/agent-registry.service';
import { StorageTrackingClientService } from '../storage-tracking/storage-tracking-client.service';
import { AgentWorkerService } from './agent-worker.service';
import { ShutdownListenerService } from './shutdown-listener.service';

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
    TypeOrmModule.forFeature([
      TcpAgent,
      TcpRole,
      TcpCompany,
      TcpAssignment,
      TcpTask,
      SpendCapState,
    ]),
    AgentRagModule,
    McpClientModule,
  ],
  providers: [
    AgentWorkerService,
    // The agent loop, plus the collaborators it delegates the run envelope,
    // the opening prompt, and its status writes to.
    AgentLoopService,
    AgentRunEnvironmentService,
    InitialStateService,
    AgentRunStatusService,
    AgentLoopEventRecorder,
    SupervisedTurnService,
    SpendGateService,
    AgentEventPublisherService,
    AgentRegistryService,
    // Answers tcp-server's drain: stops the worker taking jobs and reports how
    // many loops are genuinely still in flight.
    ShutdownListenerService,
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
