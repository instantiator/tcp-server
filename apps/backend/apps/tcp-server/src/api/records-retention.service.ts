import { AuditEventType, RecordsService } from '@tcp/shared';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';

/** How often rows past their table's retention are deleted. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Deletes record rows once their table's retention has passed (001.04), so a
 * customer's address goes when the person who set the rule said it should,
 * whether or not anyone is looking.
 *
 * Each table's deletions are audited as the system, by count only: the audit
 * log is kept after the rows are gone, so it mustn't hold their values.
 */
@Injectable()
export class RecordsRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RecordsRetentionService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly records: RecordsService,
    private readonly audit: AuditService,
  ) {}

  /** Starts the hourly sweep. */
  onModuleInit(): void {
    // In-process timer, not a BullMQ repeatable job: see
    // knowledge-reindex.service.ts for why repeatables don't suit shared-Redis
    // test runs.
    this.timer = setInterval(() => {
      void this.sweep();
    }, SWEEP_INTERVAL_MS).unref();
  }

  /** Stops the sweep. */
  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Deletes every row past its retention now. Never throws. */
  async sweep(now = new Date()): Promise<void> {
    try {
      const swept = await this.records.sweepRetention(now, (table, err) => {
        this.logger.error(
          `Retention sweep of table '${table}' failed: ${String(err)}`,
        );
      });
      for (const { companyId, table, deleted } of swept) {
        await this.audit.record(
          companyId,
          'system',
          null,
          AuditEventType.StateChange,
          { source: 'records', action: 'retention_sweep', table, deleted },
        );
        this.logger.log(
          `Retention deleted ${deleted} row(s) from '${table}' (company ${companyId})`,
        );
      }
    } catch (err) {
      this.logger.error(`Retention sweep failed: ${String(err)}`);
    }
  }
}
