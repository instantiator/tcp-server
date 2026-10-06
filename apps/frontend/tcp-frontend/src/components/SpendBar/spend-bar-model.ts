import type { CompanySpendDTO, SpendOverviewDTO } from '../../api/dtos';
import { t } from '../../strings';

/**
 * How a bar reads at a glance. `neutral` is "nothing to compare against" (no
 * cap, or a company's own total); `normal`/`warning`/`holding` are a capped
 * provider's standing against its highest-percentage limit.
 */
export type SpendBarTone = 'neutral' | 'normal' | 'warning' | 'holding';

/** What `SpendBar` needs to render: a percentage, its tone, and its words. */
export interface SpendBarData {
  readonly percent: number;
  readonly tone: SpendBarTone;
  readonly valueText: string;
  readonly details: readonly string[];
}

type Cap = SpendOverviewDTO['caps'][number];
type CapLimit = Cap['limits'][number];
type CapAction = Cap['action'];

const tokenFormatter = new Intl.NumberFormat();
const formatTokens = (count: number): string => tokenFormatter.format(count);

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const formatDate = (iso: string): string => dateFormatter.format(new Date(iso));

/** The action text for a reached cap (Design → Cap state and evaluation). */
const actionText = (action: CapAction): string => {
  switch (action) {
    case 'pause':
      return t('spend.bar.action.pause');
    case 'finish-agents':
      return t('spend.bar.action.finishAgents');
    case 'finish-tasks':
      return t('spend.bar.action.finishTasks');
  }
};

/** One limit's progress line, with or without a started stint. */
const windowLine = (provider: string, limit: CapLimit): string =>
  limit.windowStart === null
    ? t('spend.bar.detail.windowNotStarted', {
        provider,
        percent: limit.percent,
        tokens: formatTokens(limit.tokens),
        per: limit.per,
      })
    : t('spend.bar.detail.window', {
        provider,
        percent: limit.percent,
        tokens: formatTokens(limit.tokens),
        per: limit.per,
        windowStart: formatDate(limit.windowStart),
      });

/**
 * The "Companies" crumb's bar: the application's total usage with no caps
 * configured, or progress against the highest-percentage limit across every
 * configured cap.
 *
 * Every cap's own `limits` array is non-empty — `SPEND_CAPS`' Joi schema
 * refuses a cap with none — so picking the highest without a seed value is
 * safe whenever `overview.caps` itself is non-empty.
 */
export const buildOverviewBar = (overview: SpendOverviewDTO): SpendBarData => {
  if (overview.caps.length === 0) {
    const totalTokens = overview.providers.reduce(
      (sum, provider) => sum + provider.inputTokens + provider.outputTokens,
      0,
    );
    const since =
      overview.trackingSince === null
        ? t('spend.bar.noUsage')
        : formatDate(overview.trackingSince);
    return {
      percent: 100,
      tone: 'neutral',
      valueText: t('spend.bar.uncapped', {
        tokens: formatTokens(totalTokens),
        since,
      }),
      details: [],
    };
  }

  const entries = overview.caps.flatMap((cap) =>
    cap.limits.map((limit) => ({ cap, limit })),
  );
  const highest = entries.reduce((max, entry) =>
    entry.limit.percent > max.limit.percent ? entry : max,
  );

  const tone: SpendBarTone = highest.cap.holding
    ? 'holding'
    : highest.limit.percent >= 80
      ? 'warning'
      : 'normal';

  const details: string[] = [];
  for (const cap of overview.caps) {
    for (const limit of cap.limits) {
      details.push(windowLine(cap.provider, limit));
      details.push(actionText(cap.action));
      if (limit.resetsAt !== null) {
        details.push(
          t('spend.bar.detail.nextReset', {
            resetsAt: formatDate(limit.resetsAt),
          }),
        );
      }
      if (cap.holding && cap.reachedUntil !== null) {
        details.push(
          t('spend.bar.detail.pausedUntil', {
            reachedUntil: formatDate(cap.reachedUntil),
          }),
        );
      }
    }
  }

  return {
    percent: highest.limit.percent,
    tone,
    valueText: t('spend.bar.capped', {
      percent: highest.limit.percent,
      tokens: formatTokens(highest.limit.tokens),
      per: highest.limit.per,
    }),
    details,
  };
};

/**
 * The company crumb's bar: always a full, neutral bar — a company has no cap
 * of its own (Design → Configuration: caps are per-provider, application
 * level) — naming how much this company has used.
 */
export const buildCompanyBar = (spend: CompanySpendDTO): SpendBarData => {
  const totalTokens = spend.providers.reduce(
    (sum, provider) => sum + provider.inputTokens + provider.outputTokens,
    0,
  );
  const since =
    spend.trackingSince === null
      ? t('spend.bar.noUsage')
      : formatDate(spend.trackingSince);

  return {
    percent: 100,
    tone: 'neutral',
    valueText: t('spend.bar.companyUsage', {
      tokens: formatTokens(totalTokens),
      since,
    }),
    details: spend.providers.map((provider) =>
      t('spend.bar.detail.provider', {
        provider: provider.provider,
        input: formatTokens(provider.inputTokens),
        output: formatTokens(provider.outputTokens),
      }),
    ),
  };
};
