import { agentEventsChannel, WireEvent } from '@tcp/shared';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable } from 'rxjs';
import { KeyedEventBus } from './keyed-event-bus';

/**
 * Per-agent event bus feeding the `GET /api/agent/:id/events` SSE endpoint.
 *
 * Carries {@link WireEvent}s: audit rows published by tcp-server's
 * persist-then-publish path (see `AuditEventPublisher`) and stream deltas
 * published directly to the per-agent Redis channel by the out-of-process
 * tcp-agent worker. Both sides speak `WireEvent`, so the relay parses them
 * identically. See {@link KeyedEventBus} for the delivery mechanics.
 */
@Injectable()
export class AgentEventService {
  private readonly bus: KeyedEventBus<WireEvent>;

  constructor(config: ConfigService) {
    this.bus = new KeyedEventBus(
      config,
      agentEventsChannel,
      agentEventsChannel(''),
      AgentEventService.name,
    );
  }

  /** Emits a {@link WireEvent} for `agentId`. See {@link KeyedEventBus.emit}. */
  emit(agentId: string, event: WireEvent): void {
    this.bus.emit(agentId, event);
  }

  /** Observes {@link WireEvent}s for `agentId`. See {@link KeyedEventBus.observe}. */
  observe(agentId: string): Observable<WireEvent> {
    return this.bus.observe(agentId);
  }

  /** Releases the agent's subject and Redis subscription. See {@link KeyedEventBus.cleanup}. */
  cleanup(agentId: string): void {
    this.bus.cleanup(agentId);
  }

  async onModuleDestroy(): Promise<void> {
    await this.bus.onModuleDestroy();
  }
}
