import { AuditEventType } from '../models/AuditEvent.model';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

/**
 * Fire-and-forget HTTP client for writing audit events to `POST /internal/audit`
 * on tcp-server. Errors are logged but never thrown — audit failures must not
 * interrupt agent or MCP tool operations.
 *
 * Used by tcp-agent and all three MCP services. Register as a provider in the
 * host app's module alongside {@link ConfigService}.
 */
@Injectable()
export class AuditClientService {
  private readonly logger = new Logger(AuditClientService.name);
  private readonly serverUrl: string;
  private readonly apiKey: string;

  constructor(config: ConfigService) {
    this.serverUrl = config.getOrThrow<string>('TCP_SERVER_URL');
    this.apiKey = config.getOrThrow<string>('INTERNAL_API_KEY');
  }

  /**
   * Notifies tcp-server that an agent has completed with the given output.
   * Fire-and-forget — errors are logged but never thrown.
   *
   * Idempotent on the server side: if the agent is already completed (e.g.
   * because `complete_task` was called during the run) this is a no-op.
   *
   * Only used by tcp-agent; MCP services do not call this method.
   */
  notifyComplete(agentId: string, output: string): void {
    axios
      .post(
        `${this.serverUrl}/internal/agent/${agentId}/complete`,
        { output },
        { headers: { 'X-Internal-Api-Key': this.apiKey } },
      )
      .catch((err: unknown) => {
        this.logger.warn(
          `Agent complete notification failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /**
   * Notifies tcp-server that an agent run has failed with the given reason.
   * Fire-and-forget — errors are logged but never thrown.
   *
   * The server resolves any pending consultation as `failed` and resumes the
   * calling agent so it can react to the failure rather than wait forever.
   *
   * Only used by tcp-agent; MCP services do not call this method.
   */
  notifyFailed(agentId: string, reason: string): void {
    axios
      .post(
        `${this.serverUrl}/internal/agent/${agentId}/fail`,
        { reason },
        { headers: { 'X-Internal-Api-Key': this.apiKey } },
      )
      .catch((err: unknown) => {
        this.logger.warn(
          `Agent failure notification failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /** Writes an audit event. Never throws. */
  record(
    companyId: string,
    role: string,
    agentId: string | null,
    eventType: AuditEventType,
    payload: Record<string, unknown>,
  ): void {
    axios
      .post(
        `${this.serverUrl}/internal/audit`,
        { companyId, role, agentId: agentId ?? undefined, eventType, payload },
        { headers: { 'X-Internal-Api-Key': this.apiKey } },
      )
      .catch((err: unknown) => {
        this.logger.warn(
          `Audit write failed (${eventType}): ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }
}
