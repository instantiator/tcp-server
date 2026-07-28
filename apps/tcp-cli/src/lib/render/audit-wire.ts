// Translates persisted audit rows (as the `.../history` endpoints return them)
// into the wire events every rendering surface consumes. Shared by the chat
// session and the eavesdrop command, which fetch the same rows.

import type { AuditWireEvent, WireEvent } from '@tcp/shared';

/** Minimal shape of an audit row, as returned by the `.../history` endpoints. */
export interface AuditRow {
  id?: string;
  timestamp: string;
  companyId?: string;
  role?: string;
  agentId?: string | null;
  assignmentId?: string | null;
  taskId?: string | null;
  eventType: string;
  payload?: Record<string, unknown>;
}

/** Converts a persisted history row to the {@link AuditWireEvent} the render buffer consumes. */
export function toWire(row: AuditRow): AuditWireEvent {
  return {
    id: row.id,
    timestamp: row.timestamp,
    companyId: row.companyId ?? '',
    role: row.role ?? '',
    agentId: row.agentId ?? null,
    assignmentId: row.assignmentId ?? null,
    taskId: row.taskId ?? null,
    eventType: row.eventType as AuditWireEvent['eventType'],
    payload: row.payload ?? {},
  };
}

/** Wraps a persisted/synthesized audit row as an `audit` {@link WireEvent}. */
export function auditWire(event: AuditWireEvent): WireEvent {
  return { type: 'audit', event };
}

/** A synthetic terminal agent `state_change` (for locally-reported failures). */
export function failedWire(reason: string): WireEvent {
  return auditWire({
    timestamp: new Date().toISOString(),
    companyId: '',
    role: '',
    agentId: null,
    assignmentId: null,
    taskId: null,
    eventType: 'state_change',
    payload: { entity: 'agent', newStatus: 'failed', reason },
  });
}
