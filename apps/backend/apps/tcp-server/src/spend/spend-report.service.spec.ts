import { SpendCapState, TokenUsage } from '@tcp/shared';
import type { Repository } from 'typeorm';
import type { ProviderCapStatus } from './spend-cap.service';
import { SpendCapService } from './spend-cap.service';
import {
  bucketByFiveMinutes,
  SpendReportService,
} from './spend-report.service';

describe('bucketByFiveMinutes', () => {
  it('returns nothing for no rows', () => {
    expect(bucketByFiveMinutes([])).toEqual([]);
  });

  it('sums two rows that fall in the same five-minute bucket', () => {
    const buckets = bucketByFiveMinutes([
      {
        createdAt: new Date('2026-10-04T12:00:00.000Z'),
        inputTokens: 10,
        outputTokens: 1,
      },
      {
        createdAt: new Date('2026-10-04T12:04:59.000Z'),
        inputTokens: 20,
        outputTokens: 2,
      },
    ]);

    expect(buckets).toEqual([
      {
        bucketStart: '2026-10-04T12:00:00.000Z',
        inputTokens: 30,
        outputTokens: 3,
      },
    ]);
  });

  it('starts a new bucket exactly at the five-minute boundary', () => {
    const buckets = bucketByFiveMinutes([
      {
        createdAt: new Date('2026-10-04T12:04:59.999Z'),
        inputTokens: 1,
        outputTokens: 0,
      },
      {
        createdAt: new Date('2026-10-04T12:05:00.000Z'),
        inputTokens: 2,
        outputTokens: 0,
      },
    ]);

    expect(buckets.map((b) => b.bucketStart)).toEqual([
      '2026-10-04T12:00:00.000Z',
      '2026-10-04T12:05:00.000Z',
    ]);
  });

  it('orders buckets oldest first regardless of row order', () => {
    const buckets = bucketByFiveMinutes([
      {
        createdAt: new Date('2026-10-04T12:10:00.000Z'),
        inputTokens: 1,
        outputTokens: 0,
      },
      {
        createdAt: new Date('2026-10-04T12:00:00.000Z'),
        inputTokens: 1,
        outputTokens: 0,
      },
    ]);

    expect(buckets.map((b) => b.bucketStart)).toEqual([
      '2026-10-04T12:00:00.000Z',
      '2026-10-04T12:10:00.000Z',
    ]);
  });
});

describe('SpendReportService.overview', () => {
  const NOW = new Date('2026-10-04T12:00:00.000Z');

  /** A usage repo whose query builder always answers with the given raw rows. */
  function makeUsageRepo(opts: {
    trackingSince?: string;
    providers?: {
      provider: string;
      inputTokens: string;
      outputTokens: string;
    }[];
  }): Repository<TokenUsage> {
    const chain = {
      select: () => chain,
      addSelect: () => chain,
      where: () => chain,
      andWhere: () => chain,
      groupBy: () => chain,
      orderBy: () => chain,
      getRawOne: () =>
        Promise.resolve(
          opts.trackingSince ? { first: opts.trackingSince } : { first: null },
        ),
      getRawMany: () => Promise.resolve(opts.providers ?? []),
    };
    return {
      createQueryBuilder: () => chain,
    } as unknown as Repository<TokenUsage>;
  }

  function makeCaps(statuses: ProviderCapStatus[]): SpendCapService {
    return {
      statuses: () => Promise.resolve(statuses),
    } as unknown as SpendCapService;
  }

  it('reports no tracking start and no providers when nothing was recorded', async () => {
    const service = new SpendReportService(makeUsageRepo({}), makeCaps([]));

    const overview = await service.overview(NOW);

    expect(overview).toEqual({ trackingSince: null, providers: [], caps: [] });
  });

  it('converts summed string totals to numbers, ordered by provider', async () => {
    const service = new SpendReportService(
      makeUsageRepo({
        trackingSince: '2026-10-01T00:00:00.000Z',
        providers: [
          { provider: 'anthropic', inputTokens: '100', outputTokens: '20' },
        ],
      }),
      makeCaps([]),
    );

    const overview = await service.overview(NOW);

    expect(overview.trackingSince).toBe('2026-10-01T00:00:00.000Z');
    expect(overview.providers).toEqual([
      { provider: 'anthropic', inputTokens: 100, outputTokens: 20 },
    ]);
  });

  it('reports null window fields for a stint not yet started', async () => {
    const status: ProviderCapStatus = {
      provider: 'anthropic',
      cap: {
        limits: [{ tokens: 1000, per: '5h' }],
        notifyAt: [80],
        action: 'pause',
      },
      limits: [
        {
          limit: { tokens: 1000, per: '5h' },
          used: 0,
          percent: 0,
          reached: false,
          thresholds: [],
          window: { start: NOW, end: NOW, newStint: true },
        },
      ],
      state: {
        provider: 'anthropic',
        windowStarts: {},
        dismissal: 'none',
      } as SpendCapState,
    };
    const service = new SpendReportService(
      makeUsageRepo({}),
      makeCaps([status]),
    );

    const overview = await service.overview(NOW);

    expect(overview.caps).toEqual([
      {
        provider: 'anthropic',
        action: 'pause',
        dismissal: 'none',
        holding: false,
        reachedUntil: null,
        limits: [
          {
            tokens: 1000,
            per: '5h',
            used: 0,
            percent: 0,
            windowStart: null,
            resetsAt: null,
          },
        ],
      },
    ]);
  });

  it.each([
    [
      'holds while reached and not dismissed',
      {
        reachedUntil: new Date('2026-10-04T13:00:00.000Z'),
        dismissal: 'none' as const,
      },
      true,
    ],
    [
      'does not hold once dismissed',
      {
        reachedUntil: new Date('2026-10-04T13:00:00.000Z'),
        dismissal: 'indefinite' as const,
      },
      false,
    ],
  ])('%s', async (_name, stateFields, expectedHolding) => {
    const windowStart = new Date('2026-10-04T10:00:00.000Z');
    const windowEnd = new Date('2026-10-04T15:00:00.000Z');
    const status: ProviderCapStatus = {
      provider: 'anthropic',
      cap: {
        limits: [{ tokens: 1000, per: '5h' }],
        notifyAt: [80],
        action: 'pause',
      },
      limits: [
        {
          limit: { tokens: 1000, per: '5h' },
          used: 1000,
          percent: 100,
          reached: true,
          thresholds: [80, 100],
          window: { start: windowStart, end: windowEnd, newStint: false },
        },
      ],
      state: {
        provider: 'anthropic',
        windowStarts: { '5h': windowStart.toISOString() },
        updatedAt: NOW,
        ...stateFields,
      },
    };
    const service = new SpendReportService(
      makeUsageRepo({}),
      makeCaps([status]),
    );

    const overview = await service.overview(NOW);

    expect(overview.caps[0].holding).toBe(expectedHolding);
    expect(overview.caps[0].reachedUntil).toBe(
      stateFields.reachedUntil.toISOString(),
    );
    expect(overview.caps[0].limits[0]).toEqual({
      tokens: 1000,
      per: '5h',
      used: 1000,
      percent: 100,
      windowStart: windowStart.toISOString(),
      resetsAt: windowEnd.toISOString(),
    });
  });
});
