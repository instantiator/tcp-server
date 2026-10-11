import type { LifecycleRule } from '@aws-sdk/client-s3';
import { TcpCompany } from '@tcp/shared';
import { DEFAULT_STORAGE_VERSION_RETENTION_DAYS } from '@tcp/shared/config/defaults';
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntitySubscriberInterface,
  Repository,
  UpdateEvent,
} from 'typeorm';
import { S3ObjectStore } from './s3-object-store';

/** Waits this long after a company change, so its transaction has committed and a burst of saves syncs once. */
const SYNC_DELAY_MS = 1000;

/**
 * Builds the bucket's lifecycle rules: one per company folder, keeping old
 * versions for that company's `versionRetentionDays` (or `defaultDays`), plus
 * one for the soft-delete folder at the default. Every rule also clears delete
 * markers left with no versions behind them.
 *
 * ponytail: one rule per company; S3 allows about 1,000 rules per bucket, so a
 * deployment near that many companies needs one default rule plus overrides.
 */
export function retentionRules(
  companies: Pick<TcpCompany, 'slug' | 'versionRetentionDays'>[],
  defaultDays: number,
): LifecycleRule[] {
  const rule = (id: string, prefix: string, days: number): LifecycleRule => ({
    ID: id,
    Status: 'Enabled',
    Filter: { Prefix: prefix },
    NoncurrentVersionExpiration: { NoncurrentDays: days },
    Expiration: { ExpiredObjectDeleteMarker: true },
  });
  return [
    rule('soft-deleted', '_deleted/', defaultDays),
    ...companies.map((c) =>
      rule(
        `company-${c.slug}`,
        `${c.slug}/`,
        c.versionRetentionDays ?? defaultDays,
      ),
    ),
  ];
}

/**
 * Keeps old file versions for a while, so a bad change can be undone. On boot
 * it turns on bucket versioning and writes the lifecycle rules that expire old
 * versions; it rewrites the rules whenever a company is created or its
 * `versionRetentionDays` changes. A deleted company's rule is harmless and
 * goes at the next boot.
 *
 * Failures are logged, not thrown: storage still works without versioning.
 */
@Injectable()
export class StorageVersioningService
  implements
    OnApplicationBootstrap,
    OnModuleDestroy,
    EntitySubscriberInterface<TcpCompany>
{
  private readonly logger = new Logger(StorageVersioningService.name);
  private readonly store: S3ObjectStore;
  private readonly defaultDays: number;
  private pending?: NodeJS.Timeout;

  constructor(
    config: ConfigService,
    @InjectRepository(TcpCompany)
    private readonly companies: Repository<TcpCompany>,
    dataSource: DataSource,
  ) {
    this.store = new S3ObjectStore(config);
    // An empty compose variable arrives as '' rather than Joi's default.
    this.defaultDays =
      Number(config.get('STORAGE_VERSION_RETENTION_DAYS')) ||
      DEFAULT_STORAGE_VERSION_RETENTION_DAYS;
    dataSource.subscribers.push(this);
  }

  /** Subscribes to company changes only. */
  listenTo(): typeof TcpCompany {
    return TcpCompany;
  }

  /** A new company needs its own rule. */
  afterInsert(): void {
    this.scheduleSync();
  }

  /** Only a retention change alters the rules. */
  afterUpdate(event: UpdateEvent<TcpCompany>): void {
    if (
      event.updatedColumns.some(
        (c) => c.propertyName === 'versionRetentionDays',
      )
    ) {
      this.scheduleSync();
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.store.enableVersioning();
    } catch (e) {
      this.logger.warn(`Could not enable bucket versioning: ${message(e)}`);
      return;
    }
    await this.syncLifecycle();
  }

  onModuleDestroy(): void {
    clearTimeout(this.pending);
  }

  /** Rewrites the lifecycle rules from the current companies. */
  async syncLifecycle(): Promise<void> {
    try {
      const companies = await this.companies.find({
        select: { slug: true, versionRetentionDays: true },
      });
      await this.store.putLifecycleRules(
        retentionRules(companies, this.defaultDays),
      );
    } catch (e) {
      this.logger.warn(`Could not update version retention: ${message(e)}`);
    }
  }

  private scheduleSync(): void {
    clearTimeout(this.pending);
    this.pending = setTimeout(() => void this.syncLifecycle(), SYNC_DELAY_MS);
    this.pending.unref();
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
