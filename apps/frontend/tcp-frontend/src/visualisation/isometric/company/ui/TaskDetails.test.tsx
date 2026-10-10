import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../../../strings';
import { expectNoA11yViolations } from '../../../../test-support/axe';
import {
  fetchMock,
  installFetchMock,
  requestedUrls,
  respondByRoute,
  type RouteResponse,
} from '../../../../test-support/fetch-mock';
import { TaskDetails } from './TaskDetails';

const COMPANY_ID = 'company-1';
const TASK_ID = 'task-1';
const NOW = '2026-09-01T00:00:00.000Z';

const taskFixture = (overrides: Record<string, unknown> = {}) => ({
  id: TASK_ID,
  companyId: COMPANY_ID,
  request: 'Reconcile accounts',
  shortcode: 'TASK-1',
  plannerRoleId: null,
  status: 'in-progress',
  materials: [],
  expected: [],
  completed: null,
  failureReason: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const companyFixture = () => ({
  id: COMPANY_ID,
  slug: 'acme-co',
  name: 'Acme Co',
  description: 'A company',
  mcpServerList: [],
  nextTaskShortcodeIndex: 1,
});

const CLOSE_ROUTE = /\/api\/task\/task-1\/close-visualisation/;

interface Routes {
  readonly task?: Record<string, unknown>;
  readonly close?: RouteResponse;
}

/** Answers every route the panel reaches. */
const respond = ({ task = {}, close }: Routes = {}): void => {
  respondByRoute([
    [
      CLOSE_ROUTE,
      close ?? { status: 202, body: taskFixture({ status: 'succeeded' }) },
    ],
    [/\/api\/task\/task-1\/start/, { status: 202, body: taskFixture(task) }],
    [/\/api\/task\/task-1$/, { body: taskFixture(task) }],
    [/\/api\/task\?/, { body: [taskFixture(task)] }],
    [/\/api\/agent/, { body: [] }],
    [/\/api\/assignment\?/, { body: [] }],
    [/\/api\/company\/company-1\/roles/, { body: [] }],
    [/\/api\/company\/company-1(\?|$)/, { body: companyFixture() }],
  ]);
};

const renderDetails = (onRoomClosed = vi.fn()) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <aside aria-label="Task test wrapper">
          <TaskDetails
            companyId={COMPANY_ID}
            taskId={TASK_ID}
            headingId="task-heading"
            onRoomClosed={onRoomClosed}
          />
        </aside>
      </QueryClientProvider>
    </StrictMode>,
  );
  return { onRoomClosed };
};

const closeButton = () =>
  screen.queryByRole('button', { name: t('visualisation.tray.closeRoom') });

/** How many close-room POSTs have been sent. */
const closeRequests = (): number =>
  requestedUrls().filter((url) => CLOSE_ROUTE.test(url)).length;

describe('TaskDetails — closing the room', () => {
  beforeEach(() => {
    installFetchMock();
  });

  it('offers no Close room button while the task is unfinished', async () => {
    respond();
    renderDetails();

    await screen.findByText('Reconcile accounts');
    expect(closeButton()).toBeNull();
  });

  it.each(['succeeded', 'failed', 'cancelled'])(
    'offers Close room once the task has %s',
    async (status) => {
      respond({ task: { status } });
      renderDetails();

      expect(
        await screen.findByRole('button', {
          name: t('visualisation.tray.closeRoom'),
        }),
      ).toBeInTheDocument();
    },
  );

  it('offers no Close room button once the room is already closed', async () => {
    respond({ task: { status: 'succeeded', visualisationClosedAt: NOW } });
    renderDetails();

    await screen.findByText('Reconcile accounts');
    expect(closeButton()).toBeNull();
  });

  it('posts the close and tells its owner the room has closed', async () => {
    respond({ task: { status: 'failed' } });
    const user = userEvent.setup();
    const { onRoomClosed } = renderDetails();

    await user.click(
      await screen.findByRole('button', {
        name: t('visualisation.tray.closeRoom'),
      }),
    );

    await waitFor(() => {
      expect(onRoomClosed).toHaveBeenCalledTimes(1);
    });
    expect(closeRequests()).toBe(1);
    const post = fetchMock.mock.calls.find(
      ([input]) => input instanceof Request && CLOSE_ROUTE.test(input.url),
    )?.[0];
    expect(post instanceof Request ? post.method : null).toBe('POST');
  });

  it('says so when the server refuses with a 409, and keeps the button', async () => {
    respond({
      task: { status: 'failed' },
      close: { status: 409, body: { message: 'no' } },
    });
    const user = userEvent.setup();
    const { onRoomClosed } = renderDetails();

    await user.click(
      await screen.findByRole('button', {
        name: t('visualisation.tray.closeRoom'),
      }),
    );

    expect(
      await screen.findByText(
        "This task hasn't finished, so its room can't be closed.",
      ),
    ).toBeInTheDocument();
    expect(onRoomClosed).not.toHaveBeenCalled();
    expect(closeButton()).not.toBeNull();
  });

  it('has no accessibility violations with the button', async () => {
    respond({ task: { status: 'failed' } });
    renderDetails();

    await screen.findByRole('button', {
      name: t('visualisation.tray.closeRoom'),
    });
    await expectNoA11yViolations(document.body);
  });
});

// Clicking a whiteboard should offer what the task dialog does: an unstarted
// task can be started, edited or cancelled straight from the tray.
describe('TaskDetails — task controls', () => {
  beforeEach(() => {
    installFetchMock();
  });

  const control = (
    key: 'task.start' | 'task.edit' | 'task.pause' | 'task.cancel',
  ) => screen.queryByRole('button', { name: t(key) });

  it('offers Start, Edit and Cancel for a task that has not started', async () => {
    respond({ task: { status: 'ready' } });
    renderDetails();

    expect(
      await screen.findByRole('button', { name: t('task.start') }),
    ).toBeInTheDocument();
    expect(control('task.edit')).toBeInTheDocument();
    expect(control('task.cancel')).toBeInTheDocument();
    expect(control('task.pause')).toBeNull();
  });

  it('starts the task from the tray', async () => {
    const user = userEvent.setup();
    respond({ task: { status: 'ready' } });
    renderDetails();

    await user.click(
      await screen.findByRole('button', { name: t('task.start') }),
    );
    await waitFor(() => {
      expect(
        requestedUrls().some((url) => /\/api\/task\/task-1\/start/.test(url)),
      ).toBe(true);
    });
  });

  it('offers Pause and Cancel while the task runs', async () => {
    respond({ task: { status: 'in-progress' } });
    renderDetails();

    expect(
      await screen.findByRole('button', { name: t('task.pause') }),
    ).toBeInTheDocument();
    expect(control('task.cancel')).toBeInTheDocument();
    expect(control('task.start')).toBeNull();
  });

  it('offers no task controls once the task has finished', async () => {
    respond({ task: { status: 'succeeded' } });
    renderDetails();

    await screen.findByRole('button', {
      name: t('visualisation.tray.closeRoom'),
    });
    expect(control('task.cancel')).toBeNull();
  });

  it('has no accessibility violations with the controls', async () => {
    respond({ task: { status: 'ready' } });
    renderDetails();

    await screen.findByRole('button', { name: t('task.start') });
    await expectNoA11yViolations(document.body);
  });
});

describe('TaskDetails — the outputs link', () => {
  beforeEach(() => {
    installFetchMock();
  });

  afterEach(() => {
    // test-setup.ts seeds a config with no storage fields, once; reset so a
    // test that adds them doesn't leak.
    window.__TCP_CONFIG__ = {
      oidcIssuerUrl: 'https://idp.example.com',
      oidcClientId: 'tcp-web-test',
    };
  });

  const withStorageConfig = (): void => {
    window.__TCP_CONFIG__ = {
      oidcIssuerUrl: 'https://idp.example.com',
      oidcClientId: 'tcp-web-test',
      storageConsoleUrl: 'http://localhost:9001',
      storageBucket: 'tcp',
    };
  };

  it('links a succeeded task to its outputs, naming the new tab for a screen reader', async () => {
    withStorageConfig();
    respond({ task: { status: 'succeeded' } });
    renderDetails();

    const link = await screen.findByRole('link', {
      name: `${t('visualisation.tray.outputs')} ${t('visualisation.archive.linkSuffix')}`,
    });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('href')).toContain(
      encodeURIComponent('acme-co/tasks/task-1/completed/'),
    );
  });

  it('shows no link for a task that failed', async () => {
    withStorageConfig();
    respond({ task: { status: 'failed' } });
    renderDetails();

    await screen.findByText('Reconcile accounts');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('says why there is no link when storage is not configured', async () => {
    respond({ task: { status: 'succeeded' } });
    renderDetails();

    expect(
      await screen.findByText(t('visualisation.tray.outputsUnconfigured')),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
