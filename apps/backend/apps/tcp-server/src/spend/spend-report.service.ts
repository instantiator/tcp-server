import {
  CapLimitReport,
  CapReport,
  CompanySpend,
  ProviderUsage,
  SpendOverview,
  TaskUsage,
  TokenTotals,
  TokenUsage,
  UsageBucket,
} from '@tcp/shared';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { isHolding, SpendCapService } from './spend-cap.service';

/** A `GROUP BY provider` row, as the driver returns it. */
interface ProviderRow {
  provider: string;
  inputTokens: string | number;
  outputTokens: string | number;
}

/** A `GROUP BY taskId` row, as the driver returns it. */
interface TaskRow {
  taskId: UUID;
  inputTokens: string | number;
  outputTokens: string | number;
}

/** The minimum fields {@link bucketByFiveMinutes} reads off a usage row. */
interface BucketableRow {
  createdAt: Date;
  inputTokens: number;
  outputTokens: number;
}

/** One five-minute period, in milliseconds. */
const FIVE_MINUTES_MS = 300_000;
/** The series window: the last 24 hours. */
const SERIES_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Builds the read models behind `GET /api/spend` and
 * `GET /api/company/:id/spend` from {@link TokenUsage} and
 * {@link SpendCapService}'s cap state. Pure reporting — it records nothing.
 */
@Injectable()
export class SpendReportService {
  constructor(
    @InjectRepository(TokenUsage)
    private readonly usageRepo: Repository<TokenUsage>,
    private readonly caps: SpendCapService,
  ) {}

  /** Application-wide usage and every configured provider's cap progress. */
  async overview(now = new Date()): Promise<SpendOverview> {
    const [trackingSince, providers, statuses] = await Promise.all([
      this.trackingSince(),
      this.providerTotals(),
      this.caps.statuses(now),
    ]);

    const capReports: CapReport[] = statuses.map((status) => ({
      provider: status.provider,
      action: status.cap.action,
      dismissal: status.state.dismissal,
      holding: isHolding(status.state, now),
      reachedUntil: status.state.reachedUntil
        ? new Date(status.state.reachedUntil).toISOString()
        : null,
      limits: status.limits.map((limit): CapLimitReport => ({
        tokens: limit.limit.tokens,
        per: limit.limit.per,
        used: limit.used,
        percent: limit.percent,
        windowStart: limit.window.newStint
          ? null
          : limit.window.start.toISOString(),
        resetsAt: limit.window.newStint ? null : limit.window.end.toISOString(),
      })),
    }));

    return { trackingSince, providers, caps: capReports };
  }

  /** One company's totals, per-task breakdown and last-24h series. */
  async company(companyId: UUID, now = new Date()): Promise<CompanySpend> {
    const [trackingSince, providers, tasks, series] = await Promise.all([
      this.trackingSince(companyId),
      this.providerTotals(companyId),
      this.taskTotals(companyId),
      this.recentSeries(companyId, now),
    ]);

    return { trackingSince, providers, tasks, series };
  }

  /** ISO time of the first recorded usage row, optionally scoped to a company. */
  private async trackingSince(companyId?: UUID): Promise<string | null> {
    const qb = this.usageRepo
      .createQueryBuilder('u')
      .select('MIN(u.createdAt)', 'first');
    if (companyId) qb.where('u.companyId = :companyId', { companyId });
    const row = await qb.getRawOne<{ first: Date | string | null }>();
    return row?.first ? new Date(row.first).toISOString() : null;
  }

  /** Per-provider input/output totals, ordered by provider, optionally scoped to a company. */
  private async providerTotals(companyId?: UUID): Promise<ProviderUsage[]> {
    const qb = this.usageRepo
      .createQueryBuilder('u')
      .select('u.provider', 'provider')
      .addSelect('SUM(u.inputTokens)', 'inputTokens')
      .addSelect('SUM(u.outputTokens)', 'outputTokens')
      .groupBy('u.provider')
      .orderBy('u.provider', 'ASC');
    if (companyId) qb.where('u.companyId = :companyId', { companyId });
    const rows = await qb.getRawMany<ProviderRow>();
    return rows.map((row) => ({
      provider: row.provider,
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
    }));
  }

  /** Per-task totals for a company, largest total first. Task-less rows (chats) are excluded. */
  private async taskTotals(companyId: UUID): Promise<TaskUsage[]> {
    const rows = await this.usageRepo
      .createQueryBuilder('u')
      .select('u.taskId', 'taskId')
      .addSelect('SUM(u.inputTokens)', 'inputTokens')
      .addSelect('SUM(u.outputTokens)', 'outputTokens')
      .where('u.companyId = :companyId', { companyId })
      .andWhere('u.taskId IS NOT NULL')
      .groupBy('u.taskId')
      .getRawMany<TaskRow>();
    return rows
      .map((row) => ({
        taskId: row.taskId,
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
      }))
      .sort(
        (a, b) =>
          b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
      );
  }

  /**
   * The company's last 24 hours of usage, bucketed in TypeScript rather than
   * SQL so the maths is identical on Postgres and SQLite.
   * ponytail: reads every row from the last 24h; move to SQL bucketing if
   * that volume gets slow.
   */
  private async recentSeries(
    companyId: UUID,
    now: Date,
  ): Promise<UsageBucket[]> {
    const rows = await this.usageRepo.find({
      where: {
        companyId,
        createdAt: MoreThanOrEqual(new Date(now.getTime() - SERIES_WINDOW_MS)),
      },
      select: { createdAt: true, inputTokens: true, outputTokens: true },
    });
    return bucketByFiveMinutes(rows);
  }
}

/**
 * Sums `rows` into non-empty five-minute buckets, oldest first. A bucket's
 * start is the floor of its rows' timestamps to the nearest five minutes.
 */
export function bucketByFiveMinutes(rows: BucketableRow[]): UsageBucket[] {
  const totals = new Map<number, TokenTotals>();
  for (const row of rows) {
    const bucketStart =
      Math.floor(row.createdAt.getTime() / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
    const existing = totals.get(bucketStart) ?? {
      inputTokens: 0,
      outputTokens: 0,
    };
    existing.inputTokens += row.inputTokens;
    existing.outputTokens += row.outputTokens;
    totals.set(bucketStart, existing);
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bucketStart, usage]) => ({
      bucketStart: new Date(bucketStart).toISOString(),
      ...usage,
    }));
}
