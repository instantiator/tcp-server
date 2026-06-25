import { AuditEventType } from '@lcp/shared';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

/**
 * Fire-and-forget HTTP client that posts audit events to lcp-server.
 * Errors are logged but never thrown — audit failure must not break tool execution.
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
        {
          companyId,
          role,
          agentId: agentId ?? undefined,
          eventType,
          payload,
        },
        { headers: { 'X-Internal-Api-Key': this.apiKey } },
      )
      .catch((err: unknown) => {
        this.logger.warn(
          `Audit write failed (${eventType}): ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }
}
