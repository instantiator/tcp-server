import { AuditEventType } from '@lcp/shared';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

/**
 * Fire-and-forget HTTP client for writing audit events to `POST /internal/audit`
 * on lcp-server. Errors are logged but never thrown — audit failures must not
 * interrupt agent operations.
 */
@Injectable()
export class AuditClientService {
  private readonly logger = new Logger(AuditClientService.name);
  private readonly serverUrl: string;
  private readonly apiKey: string;

  constructor(config: ConfigService) {
    this.serverUrl = config.getOrThrow<string>('LCP_SERVER_URL');
    this.apiKey = config.getOrThrow<string>('INTERNAL_API_KEY');
  }

  /**
   * Notifies lcp-server that an agent has completed with the given output.
   * Fire-and-forget — errors are logged but never thrown.
   *
   * Idempotent on the server side: if the agent is already completed (e.g.
   * because `complete_task` was called during the run) this is a no-op.
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
