import {
  CONTEXT_AUDIT_SINK,
  CONTEXT_EVENT_SINK,
  ContextBudgetService,
  ContextCompactorService,
  ContextManagerService,
  IncomingDataGuardService,
  OVERFLOW_STORE,
} from '@lcp/shared';
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuditService } from '../audit/audit.service';
import { MinioModule } from '../storage/minio.module';
import { MinioService } from '../storage/minio.service';
import { AgentEventService } from '../events/agent-event.service';

/** Provides context-budget, compaction, and agent-event services to the API layer. */
@Module({
  imports: [AuditModule, MinioModule],
  providers: [
    AgentEventService,
    ContextBudgetService,
    ContextCompactorService,
    { provide: OVERFLOW_STORE, useExisting: MinioService },
    IncomingDataGuardService,
    { provide: CONTEXT_EVENT_SINK, useExisting: AgentEventService },
    { provide: CONTEXT_AUDIT_SINK, useExisting: AuditService },
    ContextManagerService,
  ],
  exports: [
    AgentEventService,
    ContextBudgetService,
    ContextCompactorService,
    IncomingDataGuardService,
    ContextManagerService,
  ],
})
export class ContextModule {}
