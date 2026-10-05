import { virtual } from '@guidepup/virtual-screen-reader';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WireEvent } from '@tcp/shared/client';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveNotifications } from '../../../api/hooks';
import { applyEvent } from '../../../events/cache';
import { t } from '../../../strings';
import {
  installFetchMock,
  respondByRoute,
} from '../../../test-support/fetch-mock';
import { NewNotificationToasts } from './NewNotificationToasts';

const COMPANY_ID = 'company-1';
const NOW = '2026-08-10T09:00:00.000Z';

const NOTIFICATIONS_ROUTE = /\/api\/notifications(\?|$)/;

interface NotificationOverrides {
  readonly id: string;
  readonly severity?: 'info' | 'warning' | 'error';
  readonly message?: string;
  readonly dismissedAt?: string;
}

const notification = (overrides: NotificationOverrides) => ({
  id: overrides.id,
  severity: overrides.severity ?? 'warning',
  kind: 'spend_threshold',
  message: overrides.message ?? `${overrides.id} message`,
  createdAt: NOW,
  ...(overrides.dismissedAt === undefined
    ? {}
    : { dismissedAt: overrides.dismissedAt }),
});

/** Answers the one query this view and its test harness both make. */
const respondNotifications = (
  list: readonly ReturnType<typeof notification>[],
): void => {
  respondByRoute([[NOTIFICATIONS_ROUTE, { body: list }]]);
};

/** A live `notification` `state_change`, as `useEventStream` hands to `applyEvent`. */
const auditEvent = (payload: Record<string, unknown>): WireEvent => ({
  type: 'audit',
  event: {
    timestamp: NOW,
    companyId: COMPANY_ID,
    role: 'system',
    agentId: null,
    assignmentId: null,
    taskId: null,
    eventType: 'state_change',
    payload,
  },
});

/**
 * Reads the same query the component under test does, so a test can wait for
 * it to settle before asserting "nothing rendered" actually means "loaded and
 * still nothing" rather than "still loading".
 */
const LoadMarker = () => {
  const query = useLiveNotifications();
  return <p>{query.isSuccess ? 'ready' : 'loading'}</p>;
};

const renderToasts = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    queryClient,
    ...render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <LoadMarker />
            <NewNotificationToasts companyId={COMPANY_ID} />
          </MemoryRouter>
        </QueryClientProvider>
      </StrictMode>,
    ),
  };
};

const waitForReady = () => screen.findByText('ready');

describe('NewNotificationToasts', () => {
  beforeEach(() => {
    installFetchMock();
  });

  it('shows no toast for a notification already present on first load', async () => {
    respondNotifications([notification({ id: 'note-1' })]);
    renderToasts();

    await waitForReady();

    expect(
      screen.queryByRole('group', { name: t('notification.label') }),
    ).toBeNull();
  });

  it('shows one toast for a notification that arrives afterwards, with a working link and dismiss', async () => {
    respondNotifications([]);
    const user = userEvent.setup();
    const { queryClient } = renderToasts();
    await waitForReady();

    const arrived = notification({
      id: 'note-2',
      message: 'A spend threshold was crossed.',
    });
    respondNotifications([arrived]);
    act(() => {
      applyEvent(
        queryClient,
        auditEvent({ entity: 'notification', summary: arrived }),
      );
    });

    const group = await screen.findByRole('group', {
      name: t('notification.label'),
    });
    expect(
      within(group).getByText('A spend threshold was crossed.'),
    ).toBeInTheDocument();

    const link = within(group).getByRole('link', {
      name: t('notifications.toast.link'),
    });
    expect(link).toHaveAttribute(
      'href',
      `/company/${COMPANY_ID}#notifications`,
    );

    await user.click(
      within(group).getByRole('button', { name: t('notification.dismiss') }),
    );
    expect(
      screen.queryByRole('group', { name: t('notification.label') }),
    ).toBeNull();
  });

  it('drops the toast when the notification is dismissed in place by a live event', async () => {
    respondNotifications([]);
    const { queryClient } = renderToasts();
    await waitForReady();

    const arrived = notification({ id: 'note-3' });
    respondNotifications([arrived]);
    act(() => {
      applyEvent(
        queryClient,
        auditEvent({ entity: 'notification', summary: arrived }),
      );
    });
    await screen.findByRole('group', { name: t('notification.label') });

    act(() => {
      applyEvent(
        queryClient,
        auditEvent({
          entity: 'notification',
          summary: { ...arrived, dismissedAt: NOW },
        }),
      );
    });

    await vi.waitFor(() => {
      expect(
        screen.queryByRole('group', { name: t('notification.label') }),
      ).toBeNull();
    });
  });

  describe('announcement', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(async () => {
      await virtual.stop();
      vi.useRealTimers();
    });

    it('announces an error-severity arrival assertively', async () => {
      respondNotifications([]);
      const { queryClient } = renderToasts();
      await waitForReady();

      await virtual.start({ container: document.body });
      await virtual.clearSpokenPhraseLog();

      const errorRow = notification({
        id: 'note-4',
        severity: 'error',
        message: 'A cap was reached.',
      });
      respondNotifications([errorRow]);
      act(() => {
        applyEvent(
          queryClient,
          auditEvent({ entity: 'notification', summary: errorRow }),
        );
      });
      await screen.findByRole('group', { name: t('notification.label') });
      await vi.advanceTimersByTimeAsync(15_000);

      expect(await virtual.spokenPhraseLog()).toEqual([
        'assertive: A cap was reached.',
      ]);
    });

    it('announces a warning-severity arrival politely', async () => {
      respondNotifications([]);
      const { queryClient } = renderToasts();
      await waitForReady();

      await virtual.start({ container: document.body });
      await virtual.clearSpokenPhraseLog();

      const warningRow = notification({
        id: 'note-5',
        severity: 'warning',
        message: 'A threshold was crossed.',
      });
      respondNotifications([warningRow]);
      act(() => {
        applyEvent(
          queryClient,
          auditEvent({ entity: 'notification', summary: warningRow }),
        );
      });
      await screen.findByRole('group', { name: t('notification.label') });
      await vi.advanceTimersByTimeAsync(15_000);

      expect(await virtual.spokenPhraseLog()).toEqual([
        'polite: A threshold was crossed.',
      ]);
    });
  });
});
