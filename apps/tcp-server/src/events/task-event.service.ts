import { taskEventsChannel, WireEvent } from '@tcp/shared';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable } from 'rxjs';
import { KeyedEventBus } from './keyed-event-bus';

/**
 * Per-task event bus feeding the `GET /api/task/:id/events` SSE endpoint —
 * task and assignment state-change {@link WireEvent}s. See
 * {@link KeyedEventBus} for the delivery mechanics.
 */
@Injectable()
export class TaskEventService {
  private readonly bus: KeyedEventBus<WireEvent>;

  constructor(config: ConfigService) {
    this.bus = new KeyedEventBus(
      config,
      taskEventsChannel,
      taskEventsChannel(''),
      TaskEventService.name,
    );
  }

  /** Emits a {@link WireEvent} for `taskId`. See {@link KeyedEventBus.emit}. */
  emit(taskId: string, event: WireEvent): void {
    this.bus.emit(taskId, event);
  }

  /** Observes {@link WireEvent}s for `taskId`. See {@link KeyedEventBus.observe}. */
  observe(taskId: string): Observable<WireEvent> {
    return this.bus.observe(taskId);
  }

  async onModuleDestroy(): Promise<void> {
    await this.bus.onModuleDestroy();
  }
}
