import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announce } from '../../announce/announcer';
import { t, tCount } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import { fetchMock, installFetchMock } from '../../test-support/fetch-mock';
import { ShutdownDialog } from './ShutdownDialog';

vi.mock('../../announce/announcer', () => ({ announce: vi.fn() }));

interface Status {
  state: 'idle' | 'draining' | 'quiesced';
  forced: boolean;
  agentsRunning: number;
  restart: boolean;
  restartSupported: boolean;
}

const idle: Status = {
  state: 'idle',
  forced: false,
  agentsRunning: 0,
  restart: false,
  restartSupported: true,
};

/** What the fake server says next; `null` makes the call fail like a dead server. */
let current: Status | null;
/** Failures to answer instead of the status, by method. */
let refuse: { method: string; status: number } | null;

const requests = () =>
  fetchMock.mock.calls.map(([input]) => {
    const request = input as Request;
    return { method: request.method, url: new URL(request.url) };
  });
const gets = () => requests().filter(({ method }) => method === 'GET');
const sent = (method: string) =>
  requests().filter((request) => request.method === method);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const renderDialog = (onClose = vi.fn()) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ShutdownDialog onClose={onClose} />
    </QueryClientProvider>,
  );

const press = async (
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) => {
  await user.click(await screen.findByRole('button', { name }));
};

describe('ShutdownDialog', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installFetchMock();
    vi.mocked(announce).mockClear();
    current = idle;
    refuse = null;
    fetchMock.mockImplementation((input) => {
      const { method } = input as Request;
      if (refuse?.method === method) {
        return Promise.resolve(
          json(refuse.status, { statusCode: refuse.status, message: 'no' }),
        );
      }
      if (current === null) return Promise.reject(new TypeError('down'));
      return Promise.resolve(json(method === 'POST' ? 202 : 200, current));
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const userSetup = () =>
    userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });

  const tick = (ms = 2_000) => act(() => vi.advanceTimersByTimeAsync(ms));

  describe('when idle', () => {
    it('explains, and offers restart, graceful and force', async () => {
      renderDialog();

      expect(await screen.findByText(t('shutdown.explain'))).toBeVisible();
      expect(screen.getByText(t('shutdown.explainRestart'))).toBeVisible();
      for (const name of ['restart', 'graceful', 'force'] as const) {
        expect(
          screen.getByRole('button', { name: t(`shutdown.${name}`) }),
        ).toBeVisible();
      }
    });

    it('hides Restart when it is not supported', async () => {
      current = { ...idle, restartSupported: false };
      renderDialog();

      await screen.findByText(t('shutdown.explain'));
      expect(
        screen.queryByRole('button', { name: t('shutdown.restart') }),
      ).toBeNull();
      expect(screen.queryByText(t('shutdown.explainRestart'))).toBeNull();
    });

    it('shuts down gracefully with no query string', async () => {
      const user = userSetup();
      renderDialog();

      await press(user, t('shutdown.graceful'));

      const [post] = sent('POST');
      expect(post?.url.search).toBe('');
    });

    it('restarts with ?restart=', async () => {
      const user = userSetup();
      renderDialog();

      await press(user, t('shutdown.restart'));

      const [post] = sent('POST');
      expect(post?.url.searchParams.has('restart')).toBe(true);
      expect(post?.url.searchParams.has('force')).toBe(false);
    });

    it('asks before forcing, then sends ?force=', async () => {
      const user = userSetup();
      renderDialog();

      await press(user, t('shutdown.force'));
      expect(screen.getByText(t('shutdown.forceConfirm'))).toBeVisible();
      expect(sent('POST')).toHaveLength(0);
      expect(
        screen.queryByRole('button', { name: t('shutdown.graceful') }),
      ).toBeNull();

      await press(user, t('shutdown.forceConfirmed'));

      const [post] = sent('POST');
      expect(post?.url.searchParams.has('force')).toBe(true);
      expect(post?.url.searchParams.has('restart')).toBe(false);
    });

    it('returns to the idle buttons on Back', async () => {
      const user = userSetup();
      renderDialog();
      await press(user, t('shutdown.force'));

      await press(user, t('shutdown.back'));

      expect(
        screen.getByRole('button', { name: t('shutdown.graceful') }),
      ).toBeVisible();
      expect(screen.getByText(t('shutdown.explain'))).toBeVisible();
      expect(sent('POST')).toHaveLength(0);
    });
  });

  describe('while draining', () => {
    it.each([1, 3])('counts %i agents and offers to cancel', async (n) => {
      current = { ...idle, state: 'draining', agentsRunning: n };
      renderDialog();

      expect(
        await screen.findByText(tCount('shutdown.draining', n)),
      ).toBeVisible();
      expect(
        screen.getByRole('button', { name: t('shutdown.cancel') }),
      ).toBeVisible();
    });

    it('says restarting, and offers to cancel the restart', async () => {
      current = { ...idle, state: 'draining', agentsRunning: 2, restart: true };
      renderDialog();

      expect(
        await screen.findByText(tCount('shutdown.restartDraining', 2)),
      ).toBeVisible();
      expect(
        screen.getByRole('button', { name: t('shutdown.cancelRestart') }),
      ).toBeVisible();
    });

    it('sends DELETE on Cancel', async () => {
      current = { ...idle, state: 'draining', agentsRunning: 1 };
      const user = userSetup();
      renderDialog();

      await press(user, t('shutdown.cancel'));

      expect(sent('DELETE')).toHaveLength(1);
    });

    it('polls while draining', async () => {
      current = { ...idle, state: 'draining', agentsRunning: 2 };
      renderDialog();
      await screen.findByText(tCount('shutdown.draining', 2));
      const before = gets().length;

      current = { ...idle, state: 'draining', agentsRunning: 1 };
      await tick();

      expect(gets().length).toBeGreaterThan(before);
      expect(
        await screen.findByText(tCount('shutdown.draining', 1)),
      ).toBeVisible();
    });
  });

  describe('when quiesced', () => {
    beforeEach(() => {
      current = { ...idle, state: 'quiesced' };
    });

    it('says the services can be stopped, and stops polling', async () => {
      renderDialog();
      expect(await screen.findByText(t('shutdown.quiesced'))).toBeVisible();
      expect(
        screen.getByRole('button', { name: t('shutdown.cancel') }),
      ).toBeVisible();
      const before = gets().length;

      await tick(10_000);

      expect(gets()).toHaveLength(before);
    });
  });

  it('stops polling when the dialog closes', async () => {
    current = { ...idle, state: 'draining', agentsRunning: 1 };
    const { unmount } = renderDialog();
    await screen.findByText(tCount('shutdown.draining', 1));
    unmount();
    const before = gets().length;

    await tick(10_000);

    expect(gets()).toHaveLength(before);
  });

  describe('a restart', () => {
    it('reports the whole flow, from draining to the system being back', async () => {
      current = { ...idle, state: 'draining', agentsRunning: 1, restart: true };
      renderDialog();
      await screen.findByText(tCount('shutdown.restartDraining', 1));

      current = { ...idle, state: 'quiesced', restart: true };
      await tick();
      expect(await screen.findByText(t('shutdown.restarting'))).toBeVisible();
      expect(
        screen.queryByRole('button', { name: t('shutdown.cancelRestart') }),
      ).toBeNull();
      expect(
        screen.queryByRole('button', { name: t('shutdown.graceful') }),
      ).toBeNull();

      current = null;
      await tick();
      expect(screen.getByText(t('shutdown.restarting'))).toBeVisible();

      current = idle;
      await tick();
      expect(await screen.findByText(t('shutdown.restarted'))).toBeVisible();
      expect(screen.getByText(t('shutdown.explain'))).toBeVisible();
      expect(
        screen.getByRole('button', { name: t('shutdown.graceful') }),
      ).toBeVisible();
    });

    it('keeps trying while the server is down', async () => {
      current = { ...idle, state: 'quiesced', restart: true };
      renderDialog();
      await screen.findByText(t('shutdown.restarting'));
      current = null;
      await tick();
      const before = gets().length;

      await tick(6_000);

      expect(gets().length).toBeGreaterThan(before);
    });
  });

  describe('announcing and focus', () => {
    it('says nothing when it opens', async () => {
      renderDialog();
      await screen.findByText(t('shutdown.explain'));

      expect(announce).not.toHaveBeenCalled();
    });

    it('announces a change once and moves focus to the status text', async () => {
      current = { ...idle, state: 'draining', agentsRunning: 2 };
      renderDialog();
      await screen.findByText(tCount('shutdown.draining', 2));

      // The count changing is not a new situation.
      current = { ...idle, state: 'draining', agentsRunning: 1 };
      await tick();
      await tick();
      expect(announce).not.toHaveBeenCalled();

      current = { ...idle, state: 'quiesced' };
      await tick();

      const message = await screen.findByText(t('shutdown.quiesced'));
      expect(announce).toHaveBeenCalledTimes(1);
      expect(announce).toHaveBeenCalledWith({
        channel: 'shutdown',
        change: 'shutdown.announce.quiesced',
      });
      expect(message).toHaveFocus();
    });

    it('moves focus to the confirmation text when Force is pressed', async () => {
      const user = userSetup();
      renderDialog();

      await press(user, t('shutdown.force'));

      expect(screen.getByText(t('shutdown.forceConfirm'))).toHaveFocus();
    });
  });

  describe('when the server refuses', () => {
    it('explains a 409 in plain words', async () => {
      refuse = { method: 'POST', status: 409 };
      const user = userSetup();
      renderDialog();

      await press(user, t('shutdown.graceful'));

      expect(
        await screen.findByText(t('refusal.shutdown.wrongState')),
      ).toBeVisible();
    });

    it('explains a 503 in plain words', async () => {
      refuse = { method: 'POST', status: 503 };
      const user = userSetup();
      renderDialog();

      await press(user, t('shutdown.restart'));

      expect(await screen.findByText(t('refusal.shuttingDown'))).toBeVisible();
    });

    it('explains a 403 on cancel', async () => {
      current = { ...idle, state: 'draining', agentsRunning: 1 };
      refuse = { method: 'DELETE', status: 403 };
      const user = userSetup();
      renderDialog();

      await press(user, t('shutdown.cancel'));

      expect(await screen.findByText(t('refusal.forbidden'))).toBeVisible();
    });
  });

  it('shows an error with a retry when the status cannot be loaded', async () => {
    current = null;
    renderDialog();

    expect(await screen.findByText(t('shutdown.error'))).toBeVisible();
  });

  it('has no accessibility violations', async () => {
    renderDialog();
    await screen.findByText(t('shutdown.explain'));

    await expectNoA11yViolations(document.body);
  });
});
