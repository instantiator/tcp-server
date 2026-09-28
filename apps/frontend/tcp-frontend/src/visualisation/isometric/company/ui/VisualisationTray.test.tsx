import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WireEvent } from '@tcp/shared/client';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { statusLabel } from '../../../../api/statuses';
import { applyEvent } from '../../../../events/cache';
import { ChatContext } from '../../../../components/ChatDialog/useChat';
import { t } from '../../../../strings';
import { expectNoA11yViolations } from '../../../../test-support/axe';
import {
  installFetchMock,
  respondByRoute,
  type RouteResponse,
} from '../../../../test-support/fetch-mock';
import { modeLabel } from './modeLabel';
import { VisualisationTray } from './VisualisationTray';

const COMPANY_ID = 'company-1';
const NOW = '2026-09-01T00:00:00.000Z';

const ROLE_ID = 'role-1';
const ROLE_NAME = 'Sales';
const AGENT_ID = 'agent-1';
const ASSIGNMENT_ID = 'assign-1';
const TASK_ID = 'task-1';

const roleFixture = () => ({
  id: ROLE_ID,
  companyId: COMPANY_ID,
  slug: 'sales',
  name: ROLE_NAME,
  description: 'Sells things',
  knowledgeDomains: [],
  mcpServerList: [],
  queryIndex: 0,
});

const agentFixture = (status = 'running') => ({
  id: AGENT_ID,
  companyId: COMPANY_ID,
  roleId: ROLE_ID,
  assignmentId: ASSIGNMENT_ID,
  status,
  threadId: null,
  initialPrompt: 'go',
  createdAt: NOW,
  output: null,
  updatedAt: NOW,
});

const assignmentFixture = (status = 'in-progress') => ({
  id: ASSIGNMENT_ID,
  taskId: TASK_ID,
  companyId: COMPANY_ID,
  mode: 'implement',
  orderIndex: 0,
  prompt: 'Reconcile the Q3 accounts',
  shortcode: 'A1',
  roleId: ROLE_ID,
  status,
  failureReason: null,
  agentId: AGENT_ID,
  targetAssignmentId: null,
  parentAssignmentId: null,
  materials: [],
  expected: [],
  prepared: [],
  approved: [],
  summary: null,
  qaStatus: null,
  qaFeedback: null,
  qaAttempts: 0,
  createdAt: NOW,
  updatedAt: NOW,
});

const taskFixture = (status = 'in-progress') => ({
  id: TASK_ID,
  companyId: COMPANY_ID,
  request: 'Reconcile accounts',
  shortcode: 'TASK-1',
  plannerRoleId: null,
  status,
  materials: [],
  expected: [],
  completed: null,
  failureReason: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const AGENT_ROUTE = /\/api\/agent\/agent-1(\?|$)/;
const ASSIGNMENTS_ROUTE = /\/api\/assignment\?/;
const ROLES_ROUTE = /\/api\/company\/company-1\/roles/;
const TASKS_ROUTE = /\/api\/task\?/;
const COMPANY_ROUTE = /\/api\/company\/company-1(\?|$)/;

const companyFixture = () => ({
  id: COMPANY_ID,
  slug: 'acme-co',
  name: 'Acme Co',
  description: 'A company',
  mcpServerList: [],
  nextTaskShortcodeIndex: 1,
});

interface Routes {
  readonly agent?: RouteResponse;
  readonly assignments?: RouteResponse;
  readonly roles?: RouteResponse;
  readonly tasks?: RouteResponse;
  readonly company?: RouteResponse;
}

/** Answers every route any of the four detail panels can reach. */
const respond = (overrides: Routes = {}): void => {
  respondByRoute([
    [AGENT_ROUTE, overrides.agent ?? { body: agentFixture() }],
    [
      ASSIGNMENTS_ROUTE,
      overrides.assignments ?? { body: [assignmentFixture()] },
    ],
    [ROLES_ROUTE, overrides.roles ?? { body: [roleFixture()] }],
    [TASKS_ROUTE, overrides.tasks ?? { body: [taskFixture()] }],
    [COMPANY_ROUTE, overrides.company ?? { body: companyFixture() }],
  ]);
};

const renderTray = (
  overrides: Partial<ComponentProps<typeof VisualisationTray>> = {},
) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onToggleFollow = vi.fn();
  const onClose = vi.fn();
  const openChat = vi.fn();
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ChatContext.Provider
        value={{ openChat, closeChat: vi.fn(), startChat: vi.fn() }}
      >
        <VisualisationTray
          companyId={COMPANY_ID}
          selection={{ kind: 'agent', id: AGENT_ID }}
          following={false}
          onToggleFollow={onToggleFollow}
          onClose={onClose}
          {...overrides}
        />
      </ChatContext.Provider>
    </QueryClientProvider>,
  );
  return { ...utils, queryClient, onToggleFollow, onClose, openChat };
};

/** A live `agent` `state_change`, in the shape the company stream sends it. */
const agentStateChangeEvent = (status: string): WireEvent => ({
  type: 'audit',
  event: {
    id: `state-agent-${status}`,
    timestamp: NOW,
    companyId: COMPANY_ID,
    role: 'orchestrator',
    agentId: AGENT_ID,
    assignmentId: null,
    taskId: null,
    eventType: 'state_change',
    payload: { entity: 'agent', newStatus: status },
  },
});

describe('VisualisationTray', () => {
  beforeEach(() => {
    installFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows an agent's heading and live details", async () => {
    respond();
    renderTray();

    const aside = await screen.findByRole('complementary', {
      name: t('visualisation.tray.agentHeading', { role: ROLE_NAME }),
    });
    expect(within(aside).getByText(statusLabel('running'))).toBeInTheDocument();
    expect(within(aside).getByText(modeLabel('implement'))).toBeInTheDocument();
    expect(
      within(aside).getByText(statusLabel('in-progress')),
    ).toBeInTheDocument();
    expect(
      within(aside).getByText('Reconcile the Q3 accounts'),
    ).toBeInTheDocument();
  });

  it('listens in on an active agent through the chat dialog, read-only', async () => {
    respond();
    const { openChat } = renderTray();

    await userEvent.click(
      await screen.findByRole('button', {
        name: t('visualisation.tray.listenIn', { role: ROLE_NAME }),
      }),
    );

    expect(openChat).toHaveBeenCalledWith({
      agentId: AGENT_ID,
      roleName: ROLE_NAME,
      reference: 'A1',
      readOnly: true,
    });
  });

  it('reads "waiting to start" for an idle task agent on an in-progress assignment', async () => {
    // 002.02 stage 4 (decision 4): idle only ever means "created, not
    // started" for a task agent, most often queued behind the worker slot.
    respond({ agent: { body: agentFixture('idle') } });
    renderTray();

    const aside = await screen.findByRole('complementary', {
      name: t('visualisation.tray.agentHeading', { role: ROLE_NAME }),
    });
    expect(
      within(aside).getByText(t('visualisation.activity.waiting')),
    ).toBeInTheDocument();
    expect(within(aside).queryByText(statusLabel('idle'))).toBeNull();
  });

  it('has no accessibility violations reading "waiting to start"', async () => {
    respond({ agent: { body: agentFixture('idle') } });
    renderTray();

    await screen.findByText(t('visualisation.activity.waiting'));
    await expectNoA11yViolations(document.body);
  });

  it('offers no listening in once the agent has finished', async () => {
    respond({ agent: { body: agentFixture('completed') } });
    renderTray();

    await screen.findByText(statusLabel('completed'));
    expect(
      screen.queryByRole('button', {
        name: t('visualisation.tray.listenIn', { role: ROLE_NAME }),
      }),
    ).not.toBeInTheDocument();
  });

  it("shows a task's heading and live details, including its assignments", async () => {
    respond();
    renderTray({ selection: { kind: 'task', id: TASK_ID } });

    const aside = await screen.findByRole('complementary', {
      name: t('visualisation.tray.taskHeading', { shortcode: 'TASK-1' }),
    });
    expect(within(aside).getByText('Reconcile accounts')).toBeInTheDocument();
    expect(
      within(aside).getByText(statusLabel('in-progress')),
    ).toBeInTheDocument();
    expect(
      within(aside).getByText(
        t('visualisation.tray.assignmentRow', {
          role: ROLE_NAME,
          mode: modeLabel('implement'),
          status: statusLabel('in-progress'),
        }),
      ),
    ).toBeInTheDocument();
  });

  it("clips a long task request to an excerpt with a '…' that reveals the rest", async () => {
    const longRequest =
      'Reconcile every account in the September ledger against the bank statements, tracing each discrepancy back to the journal entry that raised it, and write up what you find for the finance team.';
    respond({ tasks: { body: [{ ...taskFixture(), request: longRequest }] } });
    renderTray({ selection: { kind: 'task', id: TASK_ID } });

    const more = await screen.findByRole('button', {
      name: t('visualisation.tray.prompt.expand'),
    });
    expect(screen.queryByText(longRequest)).not.toBeInTheDocument();

    await userEvent.click(more);
    expect(screen.getByText(longRequest)).toBeInTheDocument();
  });

  it("shows a role's heading and description", async () => {
    respond();
    renderTray({ selection: { kind: 'role', id: ROLE_ID } });

    const aside = await screen.findByRole('complementary', {
      name: t('visualisation.tray.roleHeading', { name: ROLE_NAME }),
    });
    expect(within(aside).getByText('Sells things')).toBeInTheDocument();
  });

  it('renders ArchiveDetails for an archive selection', async () => {
    respond({ tasks: { body: [taskFixture('succeeded')] } });
    renderTray({ selection: { kind: 'archive' } });

    await screen.findByText(/TASK-1/);
    expect(
      screen.getByRole('complementary', {
        name: t('visualisation.archive.heading'),
      }),
    ).toBeInTheDocument();
  });

  it('has no accessibility violations for the archive, with its links', async () => {
    window.__TCP_CONFIG__ = {
      oidcIssuerUrl: 'https://idp.example.com',
      oidcClientId: 'tcp-web-test',
      storageConsoleUrl: 'http://localhost:9001',
      storageBucket: 'tcp',
    };
    try {
      respond({ tasks: { body: [taskFixture('succeeded')] } });
      renderTray({ selection: { kind: 'archive' } });

      await screen.findByRole('link', { name: /^TASK-1 — / });
      await expectNoA11yViolations(document.body);
    } finally {
      window.__TCP_CONFIG__ = {
        oidcIssuerUrl: 'https://idp.example.com',
        oidcClientId: 'tcp-web-test',
      };
    }
  });

  it('shows "gone" for an agent id the company no longer has', async () => {
    respond({ agent: { status: 404, body: { message: 'not found' } } });
    renderTray();

    // Loading and gone share the same generic heading, so waiting on the
    // heading alone would pass while the query is still pending. Waiting on
    // the "gone" text itself is what actually proves the error was reached.
    await screen.findByText(t('visualisation.tray.gone'));
    expect(
      screen.getByRole('complementary', {
        name: t('visualisation.tray.heading'),
      }),
    ).toBeInTheDocument();
  });

  it('reflects a live agent status patch applied to the query cache', async () => {
    respond();
    const { queryClient } = renderTray();

    await screen.findByText(statusLabel('running'));

    act(() => {
      applyEvent(queryClient, agentStateChangeEvent('paused'));
    });

    expect(await screen.findByText(statusLabel('paused'))).toBeInTheDocument();
    expect(screen.queryByText(statusLabel('running'))).toBeNull();
  });

  it('reflects `following` on the Follow toggle, and calls onToggleFollow when pressed', async () => {
    respond();
    const user = userEvent.setup();
    const { onToggleFollow } = renderTray({ following: true });

    await screen.findByRole('complementary', {
      name: t('visualisation.tray.agentHeading', { role: ROLE_NAME }),
    });
    const followButton = screen.getByRole('button', {
      name: t('visualisation.tray.follow'),
    });
    expect(followButton).toHaveAttribute('aria-pressed', 'true');

    await user.click(followButton);
    expect(onToggleFollow).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Close details is pressed', async () => {
    respond();
    const user = userEvent.setup();
    const { onClose } = renderTray();

    await screen.findByRole('complementary', {
      name: t('visualisation.tray.agentHeading', { role: ROLE_NAME }),
    });
    await user.click(
      screen.getByRole('button', { name: t('visualisation.tray.close') }),
    );

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('has no accessibility violations', async () => {
    respond();
    renderTray();

    await screen.findByRole('complementary', {
      name: t('visualisation.tray.agentHeading', { role: ROLE_NAME }),
    });
    await expectNoA11yViolations(document.body);
  });
});
