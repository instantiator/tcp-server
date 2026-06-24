import { Module } from '@nestjs/common';
import { MinioModule } from '../storage/minio.module';
import { AgentEventService } from '../events/agent-event.service';
import { ContextBudgetService } from './context-budget.service';
import { ContextCompactorService } from './context-compactor.service';
import { ContextManagerService } from './context-manager.service';
import { IncomingDataGuardService } from './incoming-data-guard.service';

/** Provides context-budget, compaction, and agent-event services to the API layer. */
@Module({
  imports: [MinioModule],
  providers: [
    AgentEventService,
    ContextBudgetService,
    ContextCompactorService,
    IncomingDataGuardService,
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
