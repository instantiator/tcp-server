import { AuditEvent, AuditWireEvent } from '@tcp/shared';
import { Injectable } from '@nestjs/common';
import { AgentEventService } from './agent-event.service';
import { CompanyEventService } from './company-event.service';
import { TaskEventService } from './task-event.service';

/** Serializes a persisted {@link AuditEvent} row to its wire shape. */
export function toWireEvent(event: AuditEvent): AuditWireEvent {
  return {
    id: event.id,
    timestamp:
      event.timestamp instanceof Date
        ? event.timestamp.toISOString()
        : String(event.timestamp),
    companyId: event.companyId,
    role: event.role,
    agentId: event.agentId,
    assignmentId: event.assignmentId,
    taskId: event.taskId,
    eventType: event.eventType,
    payload: event.payload,
  };
}

/**
 * `payload.entity` values that reach a company's stream. Widened in 002.04
 * so the live activity view's agent, consultation and enquiry lists update
 * (ADR-023); before that only tasks could. Every audit write already flows
 * through this one point, so this is a predicate change, not an
 * architecture change.
 */
const COMPANY_CHANNEL_ENTITIES = new Set([
  'company',
  'task',
  'agent',
  'assignment',
  'enquiry',
]);

/**
 * The single live-publish point for audit events. Every write flows through
 * here after it is persisted (see `AuditService.write`), so the live stream
 * and history are one source of truth (`docs/prompts/010.5.1` A.7).
 *
 * Routes one saved row to the three scoped SSE channels per the A.6 rules:
 * - agent channel: any row with an `agentId`;
 * - task channel: rows with a `taskId` whose `payload.entity` is `task` or
 *   `assignment`;
 * - company channel: rows whose `payload.entity` is in
 *   {@link COMPANY_CHANNEL_ENTITIES}.
 */
@Injectable()
export class AuditEventPublisher {
  constructor(
    private readonly agentEvents: AgentEventService,
    private readonly taskEvents: TaskEventService,
    private readonly companyEvents: CompanyEventService,
  ) {}

  /** Publishes a persisted (or synthesized) audit event to its scoped channels. */
  publish(event: AuditEvent): void {
    const wire = toWireEvent(event);
    const entity = wire.payload['entity'];

    if (wire.agentId) {
      this.agentEvents.emit(wire.agentId, { type: 'audit', event: wire });
    }
    if (wire.taskId && (entity === 'task' || entity === 'assignment')) {
      this.taskEvents.emit(wire.taskId, { type: 'audit', event: wire });
    }
    if (typeof entity === 'string' && COMPANY_CHANNEL_ENTITIES.has(entity)) {
      this.companyEvents.emit(wire.companyId, { type: 'audit', event: wire });
    }
  }
}
