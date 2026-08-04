import { companyEventsChannel, WireEvent } from '@tcp/shared';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable } from 'rxjs';
import { KeyedEventBus } from './keyed-event-bus';

/**
 * Per-company event bus feeding the `GET /api/company/:id/events` SSE
 * endpoint — company, task, agent, assignment and enquiry state-change
 * {@link WireEvent}s (ADR-023: the web UI's live activity view renders all
 * five as separate lists on one screen). See {@link AuditEventPublisher} for
 * which rows reach this bus, and {@link KeyedEventBus} for the delivery
 * mechanics.
 */
@Injectable()
export class CompanyEventService {
  private readonly bus: KeyedEventBus<WireEvent>;

  constructor(config: ConfigService) {
    this.bus = new KeyedEventBus(
      config,
      companyEventsChannel,
      companyEventsChannel(''),
      CompanyEventService.name,
    );
  }

  /** Emits a {@link WireEvent} for `companyId`. See {@link KeyedEventBus.emit}. */
  emit(companyId: string, event: WireEvent): void {
    this.bus.emit(companyId, event);
  }

  /** Observes {@link WireEvent}s for `companyId`. See {@link KeyedEventBus.observe}. */
  observe(companyId: string): Observable<WireEvent> {
    return this.bus.observe(companyId);
  }

  async onModuleDestroy(): Promise<void> {
    await this.bus.onModuleDestroy();
  }
}
