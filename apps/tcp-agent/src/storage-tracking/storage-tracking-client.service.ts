import { InternalApiClient } from '@tcp/shared';
import { Injectable } from '@nestjs/common';
import type { StorageChanges } from '../agent/loop-tracker';

/**
 * Fire-and-forget HTTP client that persists the in-loop storage change tracker
 * to `PATCH /internal/agent/:id/storage` on tcp-server.
 *
 * Storing this on tcp-server lets the assignment output-gate reference the
 * files an agent created/modified when reporting missing outputs.
 * Errors are logged but never thrown — tracker failures must not affect the run.
 */
@Injectable()
export class StorageTrackingClientService {
  constructor(private readonly api: InternalApiClient) {}

  /** Merges the current storage change state into the agent record on tcp-server. */
  patch(agentId: string, storage: StorageChanges): void {
    this.api.patchAndForget(
      `/internal/agent/${agentId}/storage`,
      storage,
      `Storage tracking update for agent ${agentId}`,
    );
  }
}
