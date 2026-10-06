import { SpendCapState, TokenUsage } from '@tcp/shared';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import {
  NewNotification,
  NotificationService,
} from '../notifications/notification.service';
import { SpendCapService } from './spend-cap.service';
import type { SpendCaps } from './spend-caps.config';

const NOON = new Date('2026-10-14T12:00:00.000Z');
const NEXT_MONTH = new Date('2026-11-01T00:00:00.000Z');

const CAPS: SpendCaps = {
  anthropic: {
    limits: [{ tokens: 1000, per: 'month' }],
    notifyAt: [50, 80],
    action: 'pause',
  },
};

/**
 * A SpendCapService over in-memory fakes: `total` is what the usage sum
 * returns, the state table is a map, and raised notifications are recorded.
 */
function setup(caps: SpendCaps = CAPS) {
  const usage = { total: 0 };
  const states = new Map<string, SpendCapState>();
  const raised: NewNotification[] = [];

  const usageRepo = {
    createQueryBuilder: () => {
      const chain = {
        select: () => chain,
        where: () => chain,
        andWhere: () => chain,
        getRawOne: () => Promise.resolve({ total: String(usage.total) }),
      };
      return chain;
    },
  } as unknown as Repository<TokenUsage>;
  const stateRepo = {
    find: () => Promise.resolve([...states.values()]),
    findOneBy: ({ provider }: { provider: string }) =>
      Promise.resolve(states.get(provider) ?? null),
    create: (row: Partial<SpendCapState>) => ({ ...row }) as SpendCapState,
    save: (row: SpendCapState) => {
      states.set(row.provider, { ...row });
      return Promise.resolve(row);
    },
  } as unknown as Repository<SpendCapState>;
  const notifications = {
    create: (input: NewNotification) => {
      raised.push(input);
      return Promise.resolve(null);
    },
  } as unknown as NotificationService;
  const config = { get: () => caps } as unknown as ConfigService;

  const service = new SpendCapService(
    config,
    usageRepo,
    stateRepo,
    notifications,
  );
  return { service, usage, states, raised };
}

describe('SpendCapService', () => {
  // isAnyReached/restore read the clock; pin it inside the fixtures' month.
  beforeEach(() => {
    jest.useFakeTimers({ now: NOON, doNotFake: ['nextTick', 'setImmediate'] });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('ignores usage for a provider with no cap', async () => {
    const { service, states, raised } = setup();
    await service.onUsage('openai', NOON, 10_000);
    expect(states.size).toBe(0);
    expect(raised).toHaveLength(0);
  });

  it('warns once as each threshold is crossed, not again on later usage', async () => {
    const { service, usage, raised } = setup();

    usage.total = 600; // 0 → 60%: crosses 50
    await service.onUsage('anthropic', NOON, 600);
    usage.total = 650; // 60 → 65%: crosses nothing
    await service.onUsage('anthropic', NOON, 50);
    usage.total = 850; // 65 → 85%: crosses 80
    await service.onUsage('anthropic', NOON, 200);

    expect(raised.map((n) => [n.kind, n.params?.['percent']])).toEqual([
      ['spend_threshold', 50],
      ['spend_threshold', 80],
    ]);
    expect(raised[0].dedupeKey).toBe(
      'cap:anthropic:month:2026-10-01T00:00:00.000Z:50',
    );
  });

  it('records a reached cap until its window ends, with its action, and raises an error', async () => {
    const { service, usage, states, raised } = setup();

    usage.total = 1000;
    await service.onUsage('anthropic', NOON, 1000);

    const state = states.get('anthropic');
    expect(state?.reachedUntil).toEqual(NEXT_MONTH);
    expect(state?.action).toBe('pause');
    expect(raised.at(-1)).toEqual(
      expect.objectContaining({ kind: 'spend_reached', severity: 'error' }),
    );
    await expect(service.isAnyReached()).resolves.toBe(true);
  });

  it('anchors a stint at the usage that starts it', async () => {
    const { service, usage, states } = setup({
      anthropic: {
        limits: [{ tokens: 1000, per: '5h' }],
        notifyAt: [80],
        action: 'pause',
      },
    });

    usage.total = 10;
    await service.onUsage('anthropic', NOON, 10);

    expect(states.get('anthropic')?.windowStarts).toEqual({
      '5h': NOON.toISOString(),
    });
  });

  it('evaluates concurrent usage for one provider one at a time', async () => {
    const { service, usage, raised } = setup();
    usage.total = 1000;

    await Promise.all([
      service.onUsage('anthropic', NOON, 500),
      service.onUsage('anthropic', NOON, 500),
    ]);

    // Each sees the same total; dedupe keys make the duplicates harmless.
    const reached = raised.filter((n) => n.kind === 'spend_reached');
    expect(new Set(reached.map((n) => n.dedupeKey)).size).toBe(1);
  });

  describe('resetExpired', () => {
    it('clears caps whose window has ended, ends until-reset dismissals, and announces the reset', async () => {
      const { service, usage, states, raised } = setup();
      usage.total = 1000;
      await service.onUsage('anthropic', NOON, 1000);
      await service.dismiss('anthropic', 'until-reset');

      const reset = await service.resetExpired(NEXT_MONTH);

      expect(reset).toEqual(['anthropic']);
      expect(states.get('anthropic')).toEqual(
        expect.objectContaining({ reachedUntil: undefined, dismissal: 'none' }),
      );
      expect(raised.at(-1)?.dedupeKey).toBe(
        `cap:anthropic:reset:${NEXT_MONTH.toISOString()}`,
      );
    });

    it('keeps an indefinite dismissal across a reset', async () => {
      const { service, usage, states } = setup();
      usage.total = 1000;
      await service.onUsage('anthropic', NOON, 1000);
      await service.dismiss('anthropic', 'indefinite');

      await service.resetExpired(NEXT_MONTH);

      expect(states.get('anthropic')?.dismissal).toBe('indefinite');
    });

    it('leaves a cap still in force alone', async () => {
      const { service, usage } = setup();
      usage.total = 1000;
      await service.onUsage('anthropic', NOON, 1000);

      await expect(service.resetExpired(NOON)).resolves.toEqual([]);
    });
  });

  it('stops holding once dismissed, and holds again when restored', async () => {
    const { service, usage } = setup();
    usage.total = 1000;
    await service.onUsage('anthropic', NOON, 1000);

    await service.dismiss('anthropic', 'until-reset');
    await expect(service.isAnyReached()).resolves.toBe(false);

    await service.restore('anthropic');
    await expect(service.isAnyReached()).resolves.toBe(true);
  });

  it('404s when dismissing a provider with no cap', async () => {
    const { service } = setup();
    await expect(
      service.dismiss('openai', 'indefinite'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
