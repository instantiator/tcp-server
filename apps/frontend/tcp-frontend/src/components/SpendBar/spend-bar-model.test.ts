import { describe, expect, it } from 'vitest';
import type { CompanySpendDTO, SpendOverviewDTO } from '../../api/dtos';
import { t } from '../../strings';
import { buildCompanyBar, buildOverviewBar } from './spend-bar-model';

const limit = (
  overrides: Partial<SpendOverviewDTO['caps'][number]['limits'][number]> = {},
): SpendOverviewDTO['caps'][number]['limits'][number] => ({
  tokens: 1_000_000,
  per: '5h',
  used: 500_000,
  percent: 50,
  windowStart: '2026-01-01T00:00:00.000Z',
  resetsAt: '2026-01-01T05:00:00.000Z',
  ...overrides,
});

const cap = (
  overrides: Partial<SpendOverviewDTO['caps'][number]> = {},
): SpendOverviewDTO['caps'][number] => ({
  provider: 'anthropic',
  action: 'pause',
  dismissal: 'none',
  holding: false,
  reachedUntil: null,
  limits: [limit()],
  ...overrides,
});

const overview = (
  overrides: Partial<SpendOverviewDTO> = {},
): SpendOverviewDTO => ({
  trackingSince: '2025-12-01T00:00:00.000Z',
  providers: [{ provider: 'anthropic', inputTokens: 1000, outputTokens: 500 }],
  caps: [],
  ...overrides,
});

const formatDate = (iso: string): string =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));

describe('buildOverviewBar — no caps configured', () => {
  it('sums every provider into a full, neutral bar', () => {
    const result = buildOverviewBar(
      overview({
        trackingSince: '2025-12-01T00:00:00.000Z',
        providers: [
          { provider: 'anthropic', inputTokens: 1000, outputTokens: 500 },
          { provider: 'openai', inputTokens: 200, outputTokens: 300 },
        ],
      }),
    );

    expect(result.percent).toBe(100);
    expect(result.tone).toBe('neutral');
    expect(result.valueText).toBe(
      t('spend.bar.uncapped', {
        tokens: '2,000',
        since: formatDate('2025-12-01T00:00:00.000Z'),
      }),
    );
    expect(result.details).toEqual([]);
  });

  it('says there is no usage yet when tracking has never started', () => {
    const result = buildOverviewBar(overview({ trackingSince: null }));
    expect(result.valueText).toBe(
      t('spend.bar.uncapped', {
        tokens: '1,500',
        since: t('spend.bar.noUsage'),
      }),
    );
  });
});

describe('buildOverviewBar — with caps configured', () => {
  it('picks the highest-percentage limit across two caps', () => {
    const result = buildOverviewBar(
      overview({
        caps: [
          cap({ provider: 'anthropic', limits: [limit({ percent: 40 })] }),
          cap({ provider: 'openai', limits: [limit({ percent: 65 })] }),
        ],
      }),
    );

    expect(result.percent).toBe(65);
    expect(result.valueText).toBe(
      t('spend.bar.capped', { percent: 65, tokens: '1,000,000', per: '5h' }),
    );
  });

  it('is tone "normal" below 80%, "warning" at 80% or above, and "holding" when the cap is holding', () => {
    const normal = buildOverviewBar(
      overview({ caps: [cap({ limits: [limit({ percent: 79 })] })] }),
    );
    expect(normal.tone).toBe('normal');

    const warning = buildOverviewBar(
      overview({ caps: [cap({ limits: [limit({ percent: 80 })] })] }),
    );
    expect(warning.tone).toBe('warning');

    const holding = buildOverviewBar(
      overview({
        caps: [
          cap({
            holding: true,
            reachedUntil: '2026-01-01T05:00:00.000Z',
            limits: [limit({ percent: 100 })],
          }),
        ],
      }),
    );
    expect(holding.tone).toBe('holding');
  });

  it('describes a stint not yet started, with no windowStart', () => {
    const result = buildOverviewBar(
      overview({
        caps: [
          cap({
            provider: 'anthropic',
            limits: [limit({ windowStart: null, resetsAt: null })],
          }),
        ],
      }),
    );

    expect(result.details[0]).toBe(
      t('spend.bar.detail.windowNotStarted', {
        provider: 'anthropic',
        percent: 50,
        tokens: '1,000,000',
        per: '5h',
      }),
    );
    // No resetsAt line when the stint (and so the reset) hasn't started.
    expect(result.details).not.toContain(expect.stringContaining('Next reset'));
  });

  it('omits the reset line when resetsAt is null, and includes it when present', () => {
    const withReset = buildOverviewBar(
      overview({
        caps: [
          cap({ limits: [limit({ resetsAt: '2026-01-01T05:00:00.000Z' })] }),
        ],
      }),
    );
    expect(
      withReset.details.some((line) => line.startsWith('Next reset:')),
    ).toBe(true);

    const withoutReset = buildOverviewBar(
      overview({ caps: [cap({ limits: [limit({ resetsAt: null })] })] }),
    );
    expect(
      withoutReset.details.some((line) => line.startsWith('Next reset:')),
    ).toBe(false);
  });

  it('adds a "Paused until" line only while the cap is holding', () => {
    const holding = buildOverviewBar(
      overview({
        caps: [
          cap({
            holding: true,
            reachedUntil: '2026-01-01T05:00:00.000Z',
            limits: [limit()],
          }),
        ],
      }),
    );
    expect(
      holding.details.some((line) => line.startsWith('Paused until')),
    ).toBe(true);

    const notHolding = buildOverviewBar(
      overview({ caps: [cap({ holding: false, limits: [limit()] })] }),
    );
    expect(
      notHolding.details.some((line) => line.startsWith('Paused until')),
    ).toBe(false);
  });

  it('gives each configured action its own text', () => {
    const pause = buildOverviewBar(
      overview({ caps: [cap({ action: 'pause', limits: [limit()] })] }),
    );
    expect(pause.details).toContain(t('spend.bar.action.pause'));

    const finishAgents = buildOverviewBar(
      overview({
        caps: [cap({ action: 'finish-agents', limits: [limit()] })],
      }),
    );
    expect(finishAgents.details).toContain(t('spend.bar.action.finishAgents'));

    const finishTasks = buildOverviewBar(
      overview({ caps: [cap({ action: 'finish-tasks', limits: [limit()] })] }),
    );
    expect(finishTasks.details).toContain(t('spend.bar.action.finishTasks'));
  });
});

describe('buildCompanyBar', () => {
  const companySpend = (
    overrides: Partial<CompanySpendDTO> = {},
  ): CompanySpendDTO => ({
    trackingSince: '2025-12-01T00:00:00.000Z',
    providers: [
      { provider: 'anthropic', inputTokens: 1000, outputTokens: 500 },
    ],
    tasks: [],
    series: [],
    ...overrides,
  });

  it("is always a full, neutral bar naming this company's usage", () => {
    const result = buildCompanyBar(companySpend());
    expect(result.percent).toBe(100);
    expect(result.tone).toBe('neutral');
    expect(result.valueText).toContain(
      '1,500 tokens used by this company since',
    );
  });

  it('lists one detail line per provider', () => {
    const result = buildCompanyBar(
      companySpend({
        providers: [
          { provider: 'anthropic', inputTokens: 1000, outputTokens: 500 },
          { provider: 'openai', inputTokens: 10, outputTokens: 20 },
        ],
      }),
    );
    expect(result.details).toEqual([
      t('spend.bar.detail.provider', {
        provider: 'anthropic',
        input: '1,000',
        output: '500',
      }),
      t('spend.bar.detail.provider', {
        provider: 'openai',
        input: '10',
        output: '20',
      }),
    ]);
  });

  it('says there is no usage yet when tracking has never started', () => {
    const result = buildCompanyBar(companySpend({ trackingSince: null }));
    expect(result.valueText).toBe(
      t('spend.bar.companyUsage', {
        tokens: '1,500',
        since: t('spend.bar.noUsage'),
      }),
    );
  });
});
