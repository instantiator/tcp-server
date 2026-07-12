import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import type { StorageChanges } from '../agent/loop-tracker';

/**
 * Fire-and-forget HTTP client that persists the in-loop storage change tracker
 * to `PATCH /internal/agent/:id/storage` on lcp-server.
 *
 * Storing this on lcp-server lets the assignment output-gate reference the
 * files an agent created/modified when reporting missing outputs.
 * Errors are logged but never thrown — tracker failures must not affect the run.
 */
@Injectable()
export class StorageTrackingClientService {
  private readonly logger = new Logger(StorageTrackingClientService.name);
  private readonly serverUrl: string;
  private readonly apiKey: string;

  constructor(config: ConfigService) {
    this.serverUrl = config.getOrThrow<string>('LCP_SERVER_URL');
    this.apiKey = config.getOrThrow<string>('INTERNAL_API_KEY');
  }

  /** Merges the current storage change state into the agent record on lcp-server. */
  patch(agentId: string, storage: StorageChanges): void {
    axios
      .patch(`${this.serverUrl}/internal/agent/${agentId}/storage`, storage, {
        headers: { 'X-Internal-Api-Key': this.apiKey },
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `Storage tracking update failed for agent ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }
}
