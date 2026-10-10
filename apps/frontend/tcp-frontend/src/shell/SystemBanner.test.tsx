import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announce } from '../announce/announcer';
import { SessionProvider } from '../auth/session';
import { t, type StringKey } from '../strings';
import { expectNoA11yViolations } from '../test-support/axe';
import { fetchMock, installFetchMock } from '../test-support/fetch-mock';
import { SystemBanner } from './SystemBanner';

vi.mock('../announce/announcer', () => ({ announce: vi.fn() }));

const SIGNED_IN = { userId: 'test-user' };

interface Shutdown {
  state: 'idle' | 'draining' | 'quiesced';
  restart: boolean;
}

const status = (shutdown: Shutdown, admin = false) => ({
  admin,
  shutdown,
});

const IDLE: Shutdown = { state: 'idle', restart: false };

/** What the fake server says next; `null` makes the call fail like a dead server. */
let current: ReturnType<typeof status> | null;

const statusCalls = () =>
  fetchMock.mock.calls.filter(([input]) =>
    (input as Request).url.endsWith('/api/system/status'),
  ).length;

let client: QueryClient;

const renderBanner = (session: { userId: string } | null = SIGNED_IN) =>
  render(
    <QueryClientProvider client={client}>
      <SessionProvider session={session}>
        <SystemBanner />
      </SessionProvider>
    </QueryClientProvider>,
  );

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe('SystemBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installFetchMock();
    vi.mocked(announce).mockClear();
    client = new QueryClient();
    current = status(IDLE);
    fetchMock.mockImplementation(() => {
      if (current === null) return Promise.reject(new TypeError('down'));
      return Promise.resolve(
        new Response(JSON.stringify(current), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows nothing while idle', async () => {
    const { container } = renderBanner();
    await tick(100);

    expect(statusCalls()).toBe(1);
    expect(container).toBeEmptyDOMElement();
    expect(announce).not.toHaveBeenCalled();
  });

  it.each<[string, Shutdown, StringKey]>([
    [
      'draining',
      { state: 'draining', restart: false },
      'banner.system.draining',
    ],
    [
      'draining for a restart',
      { state: 'draining', restart: true },
      'banner.system.restartDraining',
    ],
    [
      'quiesced',
      { state: 'quiesced', restart: false },
      'banner.system.quiesced',
    ],
    [
      'quiesced for a restart',
      { state: 'quiesced', restart: true },
      'banner.system.restarting',
    ],
  ])('says so when %s', async (_name, shutdown, key) => {
    current = status(shutdown);
    renderBanner();

    expect(await screen.findByText(t(key))).toBeVisible();
    expect(announce).toHaveBeenCalledWith({
      channel: 'system-banner',
      change: key,
    });
  });

  it('is shown to a non-administrator', async () => {
    current = status({ state: 'draining', restart: false }, false);
    renderBanner();

    expect(await screen.findByText(t('banner.system.draining'))).toBeVisible();
  });

  it('says the server is unreachable after a failed call', async () => {
    current = null;
    renderBanner();

    expect(
      await screen.findByText(t('banner.system.unreachable')),
    ).toBeVisible();
  });

  it('says it is restarting when the server goes away after a restart was seen', async () => {
    current = status({ state: 'draining', restart: true });
    renderBanner();
    await screen.findByText(t('banner.system.restartDraining'));

    current = null;
    await tick(5_000);

    expect(
      await screen.findByText(t('banner.system.restarting')),
    ).toBeVisible();
    expect(screen.queryByText(t('banner.system.unreachable'))).toBeNull();
  });

  it('announces a text once, not on every poll', async () => {
    current = status({ state: 'draining', restart: false });
    renderBanner();
    await screen.findByText(t('banner.system.draining'));

    await tick(15_000);

    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('refreshes every query when the server comes back, and hides the banner', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    current = null;
    renderBanner();
    await screen.findByText(t('banner.system.unreachable'));
    expect(invalidate).not.toHaveBeenCalled();

    current = status(IDLE);
    await tick(5_000);

    expect(screen.queryByText(t('banner.system.unreachable'))).toBeNull();
    expect(invalidate).toHaveBeenCalledWith();
  });

  it('polls every 30 seconds while idle', async () => {
    renderBanner();
    await tick(100);
    const before = statusCalls();

    await tick(29_000);
    expect(statusCalls()).toBe(before);

    await tick(1_500);
    expect(statusCalls()).toBe(before + 1);
  });

  it('polls every 5 seconds otherwise', async () => {
    current = status({ state: 'draining', restart: false });
    renderBanner();
    await screen.findByText(t('banner.system.draining'));
    const before = statusCalls();

    await tick(5_500);

    expect(statusCalls()).toBe(before + 1);
  });

  it('asks nothing and shows nothing when signed out', async () => {
    const { container } = renderBanner(null);
    await tick(1_000);

    expect(statusCalls()).toBe(0);
    expect(container).toBeEmptyDOMElement();
  });

  it('has no accessibility violations, and no live region of its own', async () => {
    current = status({ state: 'draining', restart: true });
    const { container } = renderBanner();
    await screen.findByText(t('banner.system.restartDraining'));

    expect(container.querySelector('[role="status"], [aria-live]')).toBeNull();
    await expectNoA11yViolations(container);
  });
});
