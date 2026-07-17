import { CompanyEvent, companyEventsChannel } from '@lcp/shared';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable } from 'rxjs';
import { KeyedEventBus } from './keyed-event-bus';

export type { CompanyEvent } from '@lcp/shared';

/**
 * Per-company event bus feeding the `GET /api/company/:id/events` SSE
 * endpoint — company entity updates and its tasks' status changes. See
 * {@link KeyedEventBus} for the delivery mechanics.
 */
@Injectable()
export class CompanyEventService {
  private readonly bus: KeyedEventBus<CompanyEvent>;

  constructor(config: ConfigService) {
    this.bus = new KeyedEventBus(
      config,
      companyEventsChannel,
      companyEventsChannel(''),
      CompanyEventService.name,
    );
  }

  /** Emits a {@link CompanyEvent} for `companyId`. See {@link KeyedEventBus.emit}. */
  emit(companyId: string, event: CompanyEvent): void {
    this.bus.emit(companyId, event);
  }

  /** Observes {@link CompanyEvent}s for `companyId`. See {@link KeyedEventBus.observe}. */
  observe(companyId: string): Observable<CompanyEvent> {
    return this.bus.observe(companyId);
  }

  async onModuleDestroy(): Promise<void> {
    await this.bus.onModuleDestroy();
  }
}
