import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

/** Discriminated union of event kinds emitted during agent processing. */
export type AgentEventKind =
  | 'processing_started'
  | 'compaction_started'
  | 'compaction_complete'
  | 'processing_complete';

/**
 * A single event emitted during agent processing and streamed to SSE clients
 * via the `GET /api/agent/:id/events` endpoint.
 */
export interface AgentEvent {
  /** Identifies the type of event. */
  kind: AgentEventKind;
  /** ISO 8601 timestamp of when the event was emitted. */
  timestamp: string;
  /** Optional payload specific to the event kind. */
  data?: Record<string, unknown>;
}

/**
 * In-memory per-agent event bus used to push processing and compaction
 * events to SSE subscribers.
 *
 * Each agent gets its own {@link Subject}; subscribers receive all events
 * emitted after they connect. The subject is cleaned up when the agent
 * is deleted to prevent memory leaks.
 *
 * ponytail: switch to Redis pub/sub if lcp-server scales horizontally
 */
@Injectable()
export class AgentEventService implements OnModuleDestroy {
  private readonly subjects = new Map<string, Subject<AgentEvent>>();

  /** Returns (or creates) the {@link Subject} for the given agent ID. */
  private getOrCreate(agentId: string): Subject<AgentEvent> {
    let subject = this.subjects.get(agentId);
    if (!subject) {
      subject = new Subject<AgentEvent>();
      this.subjects.set(agentId, subject);
    }
    return subject;
  }

  /**
   * Emits an {@link AgentEvent} to all current SSE subscribers for `agentId`.
   * No-op when no subscribers are connected.
   */
  emit(agentId: string, event: AgentEvent): void {
    this.subjects.get(agentId)?.next(event);
  }

  /**
   * Returns an {@link Observable} of events for `agentId`.
   * Subscribe to this from an SSE controller endpoint.
   */
  observe(agentId: string): Observable<AgentEvent> {
    return this.getOrCreate(agentId).asObservable();
  }

  /**
   * Completes and removes the subject for `agentId`.
   * Call this when an agent is deleted to free resources.
   */
  cleanup(agentId: string): void {
    const subject = this.subjects.get(agentId);
    if (subject) {
      subject.complete();
      this.subjects.delete(agentId);
    }
  }

  /** Completes all open subjects on module teardown. */
  onModuleDestroy(): void {
    for (const subject of this.subjects.values()) {
      subject.complete();
    }
    this.subjects.clear();
  }
}
