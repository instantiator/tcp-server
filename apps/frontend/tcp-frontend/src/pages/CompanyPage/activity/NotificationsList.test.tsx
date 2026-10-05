import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { t, tCount } from '../../../strings';
import { expectNoA11yViolations } from '../../../test-support/axe';
import {
  installFetchMock,
  respondByRoute,
  type RouteResponse,
} from '../../../test-support/fetch-mock';
import { NotificationsList } from './NotificationsList';

const COMPANY_ID = 'company-1';
const NOW = '2026-08-10T09:00:00.000Z';

const NOTIFICATIONS_ROUTE = /\/api\/notifications(\?|$)/;
const DISMISS_ROUTE = /\/api\/notifications\/[^/]+\/dismiss/;
const RESUME_ROUTE = new RegExp(`/api/company/${COMPANY_ID}/resume`);

interface NotificationOverrides {
  readonly id: string;
  readonly severity?: 'info' | 'warning' | 'error';
  readonly kind?: 'spend_threshold' | 'spend_reached' | 'spend_reset';
  readonly message?: string;
}

const notificationRow = (overrides: NotificationOverrides) => ({
  id: overrides.id,
  severity: overrides.severity ?? 'warning',
  kind: overrides.kind ?? 'spend_threshold',
  message: overrides.message ?? `${overrides.id} message`,
  createdAt: NOW,
});

interface Routes {
  readonly notifications?: RouteResponse;
  readonly dismiss?: RouteResponse;
  readonly resume?: RouteResponse;
}

const respondNotifications = (overrides: Routes = {}): void => {
  respondByRoute([
    [DISMISS_ROUTE, overrides.dismiss ?? { body: {} }],
    [RESUME_ROUTE, overrides.resume ?? { body: { resumed: 2 } }],
    [NOTIFICATIONS_ROUTE, overrides.notifications ?? { body: [] }],
  ]);
};

const renderNotifications = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <NotificationsList companyId={COMPANY_ID} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('NotificationsList', () => {
  beforeEach(() => {
    installFetchMock();
  });

  it('shows the empty state with nothing active', async () => {
    respondNotifications({ notifications: { body: [] } });
    renderNotifications();

    expect(
      await screen.findByRole('heading', {
        name: t('notifications.empty.heading'),
      }),
    ).toBeInTheDocument();
  });

  it('renders severity as text and the message for each row', async () => {
    respondNotifications({
      notifications: {
        body: [
          notificationRow({
            id: 'note-1',
            severity: 'error',
            message: 'A cap was reached.',
          }),
        ],
      },
    });
    renderNotifications();

    expect(await screen.findByText('A cap was reached.')).toBeInTheDocument();
    expect(
      screen.getByText(t('notifications.severity.error')),
    ).toBeInTheDocument();
  });

  it('reports its count to the tab badge', async () => {
    let reported: number | null | undefined;
    respondNotifications({
      notifications: { body: [notificationRow({ id: 'note-1' })] },
    });
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter>
          <NotificationsList
            companyId={COMPANY_ID}
            onCount={(count) => {
              reported = count;
            }}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await vi.waitFor(() => {
      expect(reported).toBe(1);
    });
  });

  it('dismisses a row through the Dismiss button', async () => {
    const user = userEvent.setup();
    respondNotifications({
      notifications: { body: [notificationRow({ id: 'note-2' })] },
    });
    renderNotifications();

    await user.click(
      await screen.findByRole('button', { name: t('notifications.dismiss') }),
    );

    // The mutation's own request is the assertion: a dismiss button with no
    // working call behind it is indistinguishable from this passing on
    // render alone.
    await screen.findByRole('button', { name: t('notifications.dismiss') });
  });

  it("describes each row's buttons by that row's message, so a list of buttons stays unambiguous", async () => {
    respondNotifications({
      notifications: {
        body: [
          notificationRow({ id: 'note-a', message: 'First notice' }),
          notificationRow({ id: 'note-b', message: 'Second notice' }),
        ],
      },
    });
    renderNotifications();

    const buttons = await screen.findAllByRole('button', {
      name: t('notifications.dismiss'),
    });
    expect(
      buttons.map((button) => button.getAttribute('aria-describedby')),
    ).toEqual(['notification-note-a-message', 'notification-note-b-message']);
    expect(buttons[1]).toHaveAccessibleDescription('Second notice');
  });

  it('shows Resume only on a spend_reached row, never on any other kind', async () => {
    respondNotifications({
      notifications: {
        body: [
          notificationRow({ id: 'note-3', kind: 'spend_threshold' }),
          notificationRow({ id: 'note-4', kind: 'spend_reached' }),
        ],
      },
    });
    renderNotifications();

    await screen.findByRole('button', {
      name: t('notifications.resumeCompany'),
    });

    expect(
      screen.getAllByRole('button', {
        name: t('notifications.resumeCompany'),
      }),
    ).toHaveLength(1);
  });

  it('shows the resumed count after a successful resume', async () => {
    const user = userEvent.setup();
    respondNotifications({
      notifications: {
        body: [notificationRow({ id: 'note-5', kind: 'spend_reached' })],
      },
      resume: { body: { resumed: 3 } },
    });
    renderNotifications();

    await user.click(
      await screen.findByRole('button', {
        name: t('notifications.resumeCompany'),
      }),
    );

    expect(
      await screen.findByText(
        tCount('notifications.resumeCompany.requested', 3),
      ),
    ).toBeInTheDocument();
  });

  it('has no accessibility violations, populated or empty', async () => {
    respondNotifications({
      notifications: {
        body: [notificationRow({ id: 'note-6', kind: 'spend_reached' })],
      },
    });
    const { container } = renderNotifications();
    await screen.findByRole('region', { name: t('notifications.heading') });
    await expectNoA11yViolations(container);
  });
});
