import { TaskEvent, taskEventsChannel } from '@lcp/shared';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable } from 'rxjs';
import { KeyedEventBus } from './keyed-event-bus';

export type { TaskEvent } from '@lcp/shared';

/**
 * Per-task event bus feeding the `GET /api/task/:id/events` SSE endpoint —
 * task status changes and its assignments' status changes. See
 * {@link KeyedEventBus} for the delivery mechanics.
 */
@Injectable()
export class TaskEventService {
  private readonly bus: KeyedEventBus<TaskEvent>;

  constructor(config: ConfigService) {
    this.bus = new KeyedEventBus(
      config,
      taskEventsChannel,
      taskEventsChannel(''),
      TaskEventService.name,
    );
  }

  /** Emits a {@link TaskEvent} for `taskId`. See {@link KeyedEventBus.emit}. */
  emit(taskId: string, event: TaskEvent): void {
    this.bus.emit(taskId, event);
  }

  /** Observes {@link TaskEvent}s for `taskId`. See {@link KeyedEventBus.observe}. */
  observe(taskId: string): Observable<TaskEvent> {
    return this.bus.observe(taskId);
  }

  async onModuleDestroy(): Promise<void> {
    await this.bus.onModuleDestroy();
  }
}
