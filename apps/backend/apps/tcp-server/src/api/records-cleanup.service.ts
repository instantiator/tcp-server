import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Long enough for a large company's tables; short enough not to hold up a delete. */
const CLEANUP_TIMEOUT_MS = 10_000;

/**
 * Tells tcp-mcp-records that a company has gone, so a records database of its
 * own drops that company's tables. In a shared database the company foreign
 * key has already cascaded, and the call deletes nothing.
 *
 * Best effort: the company is already deleted, so a failure is logged and
 * never undoes or fails the delete. Orphaned rows can't be reached anyway —
 * every records query is scoped to a company id, and ids are never reused.
 */
@Injectable()
export class RecordsCleanupService {
  private readonly logger = new Logger(RecordsCleanupService.name);

  constructor(private readonly config: ConfigService) {}

  /** Asks the records server to delete the company's tables, if a records server is configured. */
  async companyDeleted(companyId: string): Promise<void> {
    const url = this.config.get<string>('MCP_RECORDS_URL');
    if (!url) return;
    const target = `${new URL(url).origin}/internal/companies/${companyId}/records`;
    try {
      const res = await fetch(target, {
        method: 'DELETE',
        headers: {
          'X-Internal-Api-Key':
            this.config.getOrThrow<string>('INTERNAL_API_KEY'),
        },
        signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      this.logger.warn(
        `Couldn't delete records for company ${companyId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
