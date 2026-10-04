import { SpendCapState, TokenUsage, type CapDismissal } from '@tcp/shared';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationService } from '../notifications/notification.service';
import { evaluateLimit, type LimitProgress } from './evaluate';
import type { CapLimit, ProviderCap, SpendCaps } from './spend-caps.config';
import { windowFor, type CapWindow } from './window';

/** One limit's progress within its current window. */
export interface LimitStatus extends LimitProgress {
  window: CapWindow;
}

/** What `SPEND_CAPS` says, and where usage stands, for one capped provider. */
export interface ProviderCapStatus {
  provider: string;
  cap: ProviderCap;
  limits: LimitStatus[];
  state: SpendCapState;
}

/**
 * Evaluates `SPEND_CAPS` against recorded usage and keeps each provider's
 * `spend_cap_state` row — the row tcp-agent's gate reads before every LLM
 * call. Raises threshold, reached and reset notifications (each at most once,
 * via its dedupe key), and records dismissals.
 *
 * Resuming paused agents is not done here: that needs the agent queue, which
 * lives in the API layer — see `SpendResumeService`.
 */
@Injectable()
export class SpendCapService {
  private readonly logger = new Logger(SpendCapService.name);
  private readonly caps: SpendCaps;
  /**
   * Per-provider evaluation chains, so concurrent usage rows for one provider
   * are evaluated one at a time.
   * ponytail: in-process only — assumes a single tcp-server instance; move to
   * a row lock if tcp-server is ever scaled out.
   */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    config: ConfigService,
    @InjectRepository(TokenUsage)
    private readonly usageRepo: Repository<TokenUsage>,
    @InjectRepository(SpendCapState)
    private readonly stateRepo: Repository<SpendCapState>,
    private readonly notifications: NotificationService,
  ) {
    this.caps = config.get<SpendCaps>('SPEND_CAPS') ?? {};
  }

  /** The configured cap for `provider`, if any. */
  capFor(provider: string): ProviderCap | undefined {
    return this.caps[provider];
  }

  /** Every provider with a configured cap. */
  get cappedProviders(): string[] {
    return Object.keys(this.caps);
  }

  /**
   * Re-evaluates `provider`'s cap after a usage row of `tokens` was recorded
   * `at`. Never throws: a failed evaluation is logged, and the next usage row
   * retries it.
   */
  onUsage(provider: string, at: Date, tokens: number): Promise<void> {
    if (!this.caps[provider]) return Promise.resolve();
    const previous = this.chains.get(provider) ?? Promise.resolve();
    const next = previous
      .then(() => this.evaluate(provider, at, tokens))
      .catch((err: unknown) =>
        this.logger.error(
          `Spend cap evaluation failed for ${provider}: ${String(err)}`,
        ),
      );
    this.chains.set(provider, next);
    return next;
  }

  /** Warns, once per provider, that a provider reports no token usage. */
  async onUntracked(provider: string): Promise<void> {
    await this.notifications.create({
      severity: 'warning',
      kind: 'spend_untracked',
      message: `${provider} reports no token usage, so its spend isn't tracked${this.caps[provider] ? ' and its cap cannot be enforced' : ''}.`,
      params: { provider },
      dedupeKey: `untracked:${provider}`,
    });
  }

  /** True when any provider's cap is reached and not dismissed. */
  async isAnyReached(): Promise<boolean> {
    const states = await this.stateRepo.find();
    return states.some((state) => isHolding(state, new Date()));
  }

  /** Every capped provider's current progress, for reporting. */
  async statuses(now = new Date()): Promise<ProviderCapStatus[]> {
    return Promise.all(
      Object.entries(this.caps).map(async ([provider, cap]) => {
        const state = await this.loadState(provider);
        const limits = await Promise.all(
          cap.limits.map((limit) =>
            this.limitStatus(provider, limit, cap, state, now),
          ),
        );
        return { provider, cap, limits, state };
      }),
    );
  }

  /**
   * Lifts a provider's cap until it next resets, or indefinitely. The caller
   * resumes the agents the cap paused.
   */
  async dismiss(
    provider: string,
    until: Exclude<CapDismissal, 'none'>,
  ): Promise<SpendCapState> {
    this.assertCapped(provider);
    const state = await this.loadState(provider);
    state.dismissal = until;
    const saved = await this.stateRepo.save(state);
    await this.notifications.create({
      severity: 'info',
      kind: 'spend_reset',
      message:
        until === 'indefinite'
          ? `The ${provider} spend cap was lifted until it is restored.`
          : `The ${provider} spend cap was lifted until it next resets.`,
      params: { provider, dismissal: until },
    });
    return saved;
  }

  /** Puts a dismissed cap back into force, re-evaluating it straight away. */
  async restore(provider: string): Promise<SpendCapState> {
    this.assertCapped(provider);
    const state = await this.loadState(provider);
    state.dismissal = 'none';
    await this.stateRepo.save(state);
    await this.onUsage(provider, new Date(), 0);
    return this.loadState(provider);
  }

  /**
   * Clears every reached cap whose window has ended (and any `until-reset`
   * dismissal with it), announcing each reset.
   *
   * @returns The providers whose cap reset, so the caller can resume the
   *   agents those caps paused.
   */
  async resetExpired(now = new Date()): Promise<string[]> {
    const expired = (await this.stateRepo.find()).filter(
      (state) =>
        state.reachedUntil &&
        new Date(state.reachedUntil).getTime() <= now.getTime(),
    );
    for (const state of expired) {
      const endedAt = new Date(state.reachedUntil as Date).toISOString();
      state.reachedUntil = undefined;
      state.action = undefined;
      if (state.dismissal === 'until-reset') state.dismissal = 'none';
      await this.stateRepo.save(state);
      await this.notifications.create({
        severity: 'info',
        kind: 'spend_reset',
        message: `The ${state.provider} spend cap has reset; paused work is resuming.`,
        params: { provider: state.provider },
        dedupeKey: `cap:${state.provider}:reset:${endedAt}`,
      });
    }
    return expired.map((state) => state.provider);
  }

  /**
   * Sums each limit's window, raises the thresholds the latest `tokens` just
   * carried it past, and records whether any limit is reached. Stint anchors
   * are persisted the first time a stint is seen.
   */
  private async evaluate(
    provider: string,
    at: Date,
    tokens: number,
  ): Promise<void> {
    const cap = this.caps[provider];
    if (!cap) return;
    const state = await this.loadState(provider);

    let reachedUntil: Date | undefined;
    for (const limit of cap.limits) {
      const status = await this.limitStatus(provider, limit, cap, state, at);
      if (status.window.newStint) {
        state.windowStarts = {
          ...state.windowStarts,
          [limit.per]: status.window.start.toISOString(),
        };
      }
      const before = evaluateLimit(limit, status.used - tokens, cap.notifyAt);
      const crossed = status.thresholds.filter(
        (pct) => !before.thresholds.includes(pct),
      );
      await this.notifyThresholds(provider, status, crossed);
      if (
        status.reached &&
        (!reachedUntil || status.window.end > reachedUntil)
      ) {
        reachedUntil = status.window.end;
      }
    }

    // A reached cap keeps its later end; a window that has rolled over is the
    // reset sweep's to clear, not this evaluation's.
    if (
      reachedUntil &&
      (!state.reachedUntil || reachedUntil > new Date(state.reachedUntil))
    ) {
      state.reachedUntil = reachedUntil;
      state.action = cap.action;
    }
    await this.stateRepo.save(state);
  }

  /** One limit's window and progress, as of `at`. */
  private async limitStatus(
    provider: string,
    limit: CapLimit,
    cap: ProviderCap,
    state: SpendCapState,
    at: Date,
  ): Promise<LimitStatus> {
    const anchor = state.windowStarts[limit.per];
    const window = windowFor(
      limit.per,
      at,
      anchor ? new Date(anchor) : undefined,
    );
    const used = await this.sumUsage(provider, window.start, window.end);
    return { ...evaluateLimit(limit, used, cap.notifyAt), window };
  }

  /**
   * Raises a notification for each of `thresholds` — at most once per window,
   * by dedupe key, even if two evaluations race.
   */
  private async notifyThresholds(
    provider: string,
    status: LimitStatus,
    thresholds: number[],
  ): Promise<void> {
    const { limit, window } = status;
    for (const pct of thresholds) {
      const reached = pct >= 100;
      await this.notifications.create({
        severity: reached ? 'error' : 'warning',
        kind: reached ? 'spend_reached' : 'spend_threshold',
        message: reached
          ? `${provider} has reached its cap of ${limit.tokens} tokens per ${limit.per}.`
          : `${provider} has used ${pct}% of its cap of ${limit.tokens} tokens per ${limit.per}.`,
        params: {
          provider,
          percent: pct,
          tokens: limit.tokens,
          per: limit.per,
          windowStart: window.start.toISOString(),
          resetsAt: window.end.toISOString(),
        },
        dedupeKey: `cap:${provider}:${limit.per}:${window.start.toISOString()}:${pct}`,
      });
    }
  }

  /** Total tokens `provider` used in [from, to). */
  private async sumUsage(
    provider: string,
    from: Date,
    to: Date,
  ): Promise<number> {
    const row = await this.usageRepo
      .createQueryBuilder('u')
      .select('COALESCE(SUM(u.inputTokens + u.outputTokens), 0)', 'total')
      .where('u.provider = :provider', { provider })
      .andWhere('u.createdAt >= :from AND u.createdAt < :to', { from, to })
      .getRawOne<{ total: string | number }>();
    return Number(row?.total ?? 0);
  }

  /** The provider's state row, or a fresh unsaved one. */
  private async loadState(provider: string): Promise<SpendCapState> {
    return (
      (await this.stateRepo.findOneBy({ provider })) ??
      this.stateRepo.create({ provider, windowStarts: {}, dismissal: 'none' })
    );
  }

  /** 404s for a provider with no configured cap. */
  private assertCapped(provider: string): void {
    if (!this.caps[provider]) {
      throw new NotFoundException(`No spend cap is configured for ${provider}`);
    }
  }
}

/** True when `state` describes a reached, undismissed cap still in force at `now`. */
export function isHolding(state: SpendCapState, now: Date): boolean {
  return (
    !!state.reachedUntil &&
    state.dismissal === 'none' &&
    new Date(state.reachedUntil).getTime() > now.getTime()
  );
}
