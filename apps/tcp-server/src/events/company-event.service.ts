import { companyEventsChannel, WireEvent } from '@tcp/shared';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable } from 'rxjs';
import { KeyedEventBus } from './keyed-event-bus';

/**
 * Per-company event bus feeding the `GET /api/company/:id/events` SSE
 * endpoint — company and task state-change {@link WireEvent}s only (agent- and
 * assignment-level rows are filtered out to protect the roster TUI from
 * volume). See {@link KeyedEventBus} for the delivery mechanics.
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
