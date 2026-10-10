import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WireEvent } from '@tcp/shared/client';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { statusLabel } from '../../../../api/statuses';
import { applyEvent } from '../../../../events/cache';
import {
  ChatContext,
  type NewChat,
} from '../../../../components/ChatDialog/useChat';
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
  startChat: (chat: NewChat) => Promise<void> = vi
    .fn()
    .mockResolvedValue(undefined),
) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onToggleFollow = vi.fn();
  const onClose = vi.fn();
  const openChat = vi.fn();
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ChatContext.Provider value={{ openChat, startChat }}>
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
  return {
    ...utils,
    queryClient,
    onToggleFollow,
    onClose,
    openChat,
    startChat,
  };
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
      within(aside).getAllByText(statusLabel('in-progress')),
    ).not.toHaveLength(0);
    const list = within(aside).getByRole('list');
    expect(list).toHaveTextContent(`${ROLE_NAME} — ${modeLabel('implement')}`);
    expect(list).toHaveTextContent(statusLabel('in-progress'));
  });

  describe('the assignment lists', () => {
    const chicken = {
      ...roleFixture(),
      id: 'chicken',
      name: 'Chicken assistant',
    };
    const cat = { ...roleFixture(), id: 'cat', name: 'Cat assistant' };
    /** The user's example, created in this order; ids sort the same way. */
    const EXAMPLE = [
      ['chicken', 'plan', 'succeeded'],
      ['chicken', 'implement', 'succeeded'],
      ['chicken', 'qa', 'succeeded'],
      ['cat', 'implement', 'succeeded'],
      ['cat', 'qa', 'succeeded'],
      ['chicken', 'implement', 'in-progress'],
    ].map(([roleId, mode, status], index) => ({
      ...assignmentFixture(status),
      id: `assign-${index + 1}`,
      roleId,
      mode,
      orderIndex: 5 - index,
      prompt: `Prompt ${index + 1}`,
      createdAt: `2026-09-01T00:00:0${index}.000Z`,
    }));

    const renderTask = async (assignments = EXAMPLE) => {
      respond({
        assignments: { body: assignments },
        roles: { body: [chicken, cat] },
        tasks: { body: [{ ...taskFixture(), shortcode: '003' }] },
      });
      renderTray({ selection: { kind: 'task', id: TASK_ID } });
      return screen.findByRole('complementary', {
        name: t('visualisation.tray.taskHeading', { shortcode: '003' }),
      });
    };

    const rows = (list: HTMLElement) =>
      within(list)
        .getAllByRole('listitem')
        .map((item) => ({
          value: (item as HTMLLIElement).value,
          text: item.textContent.replace(/\s+/g, ' '),
        }));

    it('numbers by creation, in "In progress" and "Completed" sections', async () => {
      const aside = await renderTask();

      const headings = within(aside)
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent);
      expect(headings).toEqual(['In progress', 'Completed']);

      const [inProgress, completed] = within(aside).getAllByRole('list');
      expect(rows(inProgress)).toEqual([
        { value: 6, text: 'Chicken assistant — Implementing — In progress' },
      ]);
      expect(rows(completed).map((row) => row.value)).toEqual([1, 2, 3, 4, 5]);
      expect(rows(completed)[3]?.text).toBe(
        'Cat assistant — Implementing — Succeeded',
      );
    });

    it('omits a section with no rows', async () => {
      const aside = await renderTask(EXAMPLE.slice(0, 5));

      expect(
        within(aside).queryByRole('heading', { name: 'In progress' }),
      ).not.toBeInTheDocument();
      expect(
        within(aside).getByRole('heading', { name: 'Completed' }),
      ).toBeInTheDocument();
    });

    it('opens the assignment tooltip on keyboard focus', async () => {
      await renderTask();

      await userEvent.tab();
      const info = screen.getByRole('button', { name: 'About assignment 6' });
      while (document.activeElement !== info) await userEvent.tab();

      const tooltip = await screen.findByRole('tooltip');
      expect(tooltip).toHaveTextContent('Task 003, Assignment 006');
      expect(tooltip).toHaveTextContent('Prompt 6');
    });

    it('has no accessibility violations', async () => {
      await renderTask();
      await screen.findByRole('heading', { name: 'In progress' });

      await expectNoA11yViolations(document.body);
    });
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

  describe('chatting with a role (003.01 stage 4)', () => {
    const findChatButton = () =>
      screen.findByRole('button', {
        name: t('visualisation.tray.chatWithRole', { role: ROLE_NAME }),
      });

    it('starts a chat with the selected role on press', async () => {
      respond();
      const startChat = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();
      renderTray({ selection: { kind: 'role', id: ROLE_ID } }, startChat);

      await user.click(await findChatButton());

      expect(startChat).toHaveBeenCalledWith({
        companyId: COMPANY_ID,
        roleId: ROLE_ID,
        roleName: ROLE_NAME,
      });
    });

    it('shows the button pending while the attempt is in flight, then clears', async () => {
      respond();
      let resolveStart: (() => void) | undefined;
      const startChat = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveStart = resolve;
          }),
      );
      const user = userEvent.setup();
      renderTray({ selection: { kind: 'role', id: ROLE_ID } }, startChat);

      const button = await findChatButton();
      await user.click(button);

      await waitFor(() => {
        expect(button).toHaveAttribute('data-pending', 'true');
      });
      expect(button).toHaveAttribute('aria-disabled', 'true');

      await act(async () => {
        resolveStart?.();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(button).not.toHaveAttribute('data-pending');
      });
    });

    it('shows an error the button points to when starting fails', async () => {
      respond();
      const startChat = vi.fn().mockRejectedValue(new Error('network down'));
      const user = userEvent.setup();
      renderTray({ selection: { kind: 'role', id: ROLE_ID } }, startChat);

      await user.click(await findChatButton());

      const message = t('addNew.error', { role: ROLE_NAME });
      // Scoped to a `<p>`: `useStartChatAction` also speaks the same text into
      // the announcer's live region, and an unscoped query would match both.
      const errorText = await screen.findByText(message, { selector: 'p' });
      expect(await findChatButton()).toHaveAttribute(
        'aria-describedby',
        errorText.id,
      );
    });

    it('has no accessibility violations with a role selected', async () => {
      respond();
      renderTray({ selection: { kind: 'role', id: ROLE_ID } });

      await findChatButton();
      await expectNoA11yViolations(document.body);
    });
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
