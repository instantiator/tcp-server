import { Injectable } from '@nestjs/common';
import { InternalApiClient } from '../http/internal-api.client';
import type { RunFailure } from '../llm/run-failure';
import { AuditEventType } from '../models/AuditEvent.model';

/**
 * Fire-and-forget writer for agent lifecycle notifications and audit events on
 * tcp-server. Errors are logged but never thrown — audit failures must not
 * interrupt agent or MCP tool operations.
 *
 * Used by tcp-agent and all three MCP services. Register as a provider in the
 * host app's module alongside {@link InternalApiClient}.
 */
@Injectable()
export class AuditClientService {
  constructor(private readonly api: InternalApiClient) {}

  /**
   * Notifies tcp-server that an agent has completed with the given output.
   *
   * Idempotent on the server side: if the agent is already completed (e.g.
   * because `complete_task` was called during the run) this is a no-op.
   *
   * Only used by tcp-agent; MCP services do not call this method.
   */
  notifyComplete(agentId: string, output: string): void {
    this.api.postAndForget(
      `/internal/agent/${agentId}/complete`,
      { output },
      `Agent complete notification for ${agentId}`,
    );
  }

  /**
   * Notifies tcp-server that an agent run has failed, with its reason and code.
   *
   * The server resolves any pending consultation as `failed` and resumes the
   * calling agent so it can react to the failure rather than wait forever.
   *
   * Only used by tcp-agent; MCP services do not call this method.
   */
  notifyFailed(agentId: string, failure: RunFailure): void {
    this.api.postAndForget(
      `/internal/agent/${agentId}/fail`,
      { reason: failure.message, code: failure.code },
      `Agent failure notification for ${agentId}`,
    );
  }

  /** Writes an audit event. Never throws. */
  record(
    companyId: string,
    role: string,
    agentId: string | null,
    eventType: AuditEventType,
    payload: Record<string, unknown>,
  ): void {
    this.api.postAndForget(
      '/internal/audit',
      { companyId, role, agentId: agentId ?? undefined, eventType, payload },
      `Audit write (${eventType})`,
    );
  }
}
