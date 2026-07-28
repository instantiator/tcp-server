import { Module } from '@nestjs/common';
import { AgentEventService } from './agent-event.service';
import { AuditEventPublisher } from './audit-event-publisher.service';
import { CompanyEventService } from './company-event.service';
import { TaskEventService } from './task-event.service';

/**
 * Provides the three scoped {@link KeyedEventBus}-backed event services
 * (agent/task/company) and the {@link AuditEventPublisher} that routes
 * persisted audit rows onto them. Imported by {@link AuditModule} (so writes
 * publish live) and by the API layer (so controllers can observe the streams).
 */
@Module({
  providers: [
    AgentEventService,
    TaskEventService,
    CompanyEventService,
    AuditEventPublisher,
  ],
  exports: [
    AgentEventService,
    TaskEventService,
    CompanyEventService,
    AuditEventPublisher,
  ],
})
export class EventsModule {}
