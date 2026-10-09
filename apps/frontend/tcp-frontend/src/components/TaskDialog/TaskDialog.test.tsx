import { virtual } from '@guidepup/virtual-screen-reader';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuditWireEvent, WireEvent } from '@tcp/shared/client';
import { StrictMode, useState } from 'react';
import { Button } from 'react-aria-components';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { statusLabel } from '../../api/statuses';
import { streamUrls, subscribe } from '../../events/subscriptions';
import { t, type StringKey } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import {
  fetchMock,
  installFetchMock,
  respondByRoute,
  type RouteResponse,
} from '../../test-support/fetch-mock';
import { TaskDialog } from './TaskDialog';

// Mocked the way `ChatDialog.test.tsx` mocks it, keyed by **url** rather than
// held as one pair of module-level variables — this file opens a task stream
// and two agent streams at once, and a single `emit`/`fail` pair would let a
// test silently emit on the wrong one.
vi.mock('../../events/subscriptions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../events/subscriptions')>()),
  subscribe: vi.fn(),
}));

const subscribeMock = vi.mocked(subscribe);

const COMPANY_ID = 'company-1';
const TASK_ID = 'task-1';
const NOW = '2026-08-10T09:00:00.000Z';
const LATER = '2026-08-10T09:05:00.000Z';

const ROLE_A_ID = 'role-a';
const ROLE_A_NAME = 'Sales';
const ROLE_B_ID = 'role-b';
const ROLE_B_NAME = 'Legal';

const AGENT_A = 'agent-a';
const AGENT_B = 'agent-b';

const ASSIGN_A = 'assign-a';
const ASSIGN_B = 'assign-b';

/** This stream's handle, as the real `subscribe` hands to a caller. */
interface StreamHandle {
  readonly emit: (event: WireEvent) => void;
  readonly fail: (error: Error) => void;
}

// The current handle for each open url, and a running tally of subscribe
// calls minus unsubscribe calls for that url — a stand-in for
// `openStreamCount` from `subscriptions.ts`, which this mock replaces
// entirely. Built in now rather than bolted on later: it is what proves a
// collapsed panel releases its connection and an expanded one opens exactly
// one.
const handles = new Map<string, StreamHandle>();
const openCounts = new Map<string, number>();

/** Urls this test wants `subscribe` to refuse, simulating `MAX_STREAMS`. */
const refusedUrls = new Set<string>();

/** The captured handle for one open stream. Fails loudly if absent. */
const streamFor = (url: string): StreamHandle => {
  const handle = handles.get(url);
  if (handle === undefined) {
    throw new Error(`no subscription is open for ${url}`);
  }
  return handle;
};

const roleFixture = (id: string, name: string) => ({
  id,
  companyId: COMPANY_ID,
  slug: id,
  name,
  description: 'd',
  knowledgeDomains: [],
  mcpServerList: [],
  queryIndex: 0,
});

interface TaskOverrides {
  readonly status?: string;
  readonly failureReason?: string | null;
  readonly pausedAt?: string;
  readonly pausedBy?: string;
  readonly expected?: readonly { type: string; value: string }[];
}

const taskFixture = (overrides: TaskOverrides = {}) => ({
  id: TASK_ID,
  companyId: COMPANY_ID,
  request: 'Reconcile Q3 accounts',
  shortcode: 'TASK-1',
  plannerRoleId: null,
  status: overrides.status ?? 'in-progress',
  materials: [],
  expected: overrides.expected ?? [],
  completed: null,
  failureReason: overrides.failureReason ?? null,
  ...(overrides.pausedAt === undefined ? {} : { pausedAt: overrides.pausedAt }),
  ...(overrides.pausedBy === undefined ? {} : { pausedBy: overrides.pausedBy }),
  createdAt: NOW,
  updatedAt: NOW,
});

interface AssignmentOverrides {
  readonly id: string;
  readonly roleId: string;
  readonly agentId?: string | null;
  readonly status?: string;
  readonly createdAt?: string;
}

const assignmentFixture = (overrides: AssignmentOverrides) => ({
  id: overrides.id,
  taskId: TASK_ID,
  companyId: COMPANY_ID,
  mode: 'implement',
  orderIndex: 0,
  prompt: `${overrides.id} prompt`,
  shortcode: `${overrides.id}-shortcode`,
  roleId: overrides.roleId,
  status: overrides.status ?? 'in-progress',
  failureReason: null,
  agentId: overrides.agentId ?? null,
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
  createdAt: overrides.createdAt ?? NOW,
  updatedAt: NOW,
});

const ASSIGNMENT_A = assignmentFixture({
  id: ASSIGN_A,
  roleId: ROLE_A_ID,
  agentId: AGENT_A,
  status: 'in-progress',
  createdAt: NOW,
});
const ASSIGNMENT_B = assignmentFixture({
  id: ASSIGN_B,
  roleId: ROLE_B_ID,
  agentId: AGENT_B,
  status: 'ready',
  createdAt: LATER,
});

const auditEvent = (
  agentId: string,
  overrides: Partial<AuditWireEvent> & Pick<AuditWireEvent, 'eventType'>,
): AuditWireEvent => ({
  id: `audit-${agentId}-${overrides.eventType}`,
  timestamp: NOW,
  companyId: COMPANY_ID,
  role: 'user',
  agentId,
  assignmentId: null,
  taskId: null,
  payload: {},
  ...overrides,
});

interface AssignmentSummary {
  readonly id: string;
  readonly status: string;
  readonly mode: string;
  readonly orderIndex: number | null;
  readonly roleId: string;
}

/** A live `assignment` `state_change`, as it arrives on the task's own stream. */
const assignmentStateChangeEvent = (summary: AssignmentSummary): WireEvent => ({
  type: 'audit',
  event: {
    id: `state-${summary.id}-${summary.status}`,
    timestamp: NOW,
    companyId: COMPANY_ID,
    role: 'orchestrator',
    agentId: null,
    assignmentId: summary.id,
    taskId: TASK_ID,
    eventType: 'state_change',
    payload: { entity: 'assignment', newStatus: summary.status, summary },
  },
});

interface TaskSummary {
  readonly id: string;
  readonly status: string;
  readonly request: string;
  readonly shortcode: string;
}

/** A live `task` `state_change`, as it arrives on the task's own stream. */
const taskStateChangeEvent = (summary: TaskSummary): WireEvent => ({
  type: 'audit',
  event: {
    id: `state-task-${summary.status}`,
    timestamp: NOW,
    companyId: COMPANY_ID,
    role: 'orchestrator',
    agentId: null,
    assignmentId: null,
    taskId: TASK_ID,
    eventType: 'state_change',
    payload: {
      entity: 'task',
      newStatus: summary.status,
      summary: {
        ...summary,
        createdAt: NOW,
        updatedAt: NOW,
        completedSteps: 0,
        totalSteps: 0,
      },
    },
  },
});

/** A live token delta, as it arrives on one agent's own stream. */
const streamDeltaEvent = (agentId: string, delta: string): WireEvent => ({
  type: 'stream',
  agentId,
  channel: 'response',
  delta,
  timestamp: NOW,
});

/** A company agent working one of the fixture assignments. */
const agentFixture = (assignmentId: string, status: string) => ({
  id: `agent-for-${assignmentId}`,
  companyId: COMPANY_ID,
  roleId: ROLE_A_ID,
  assignmentId,
  status,
  threadId: null,
  initialPrompt: 'p',
  createdAt: NOW,
  output: null,
});

const TASK_START_ROUTE = /\/api\/task\/task-1\/start/;
const TASK_PAUSE_ROUTE = /\/api\/task\/task-1\/pause/;
const TASK_RESUME_ROUTE = /\/api\/task\/task-1\/resume/;
const AGENTS_ROUTE = /\/api\/agent\?/;
const TASK_CANCEL_ROUTE = /\/api\/task\/task-1\/cancel/;
const TASK_ROUTE = /\/api\/task\/task-1(\?|$)/;
const ASSIGNMENTS_ROUTE = /\/api\/assignment\?/;
const ROLES_ROUTE = /\/api\/company\/company-1\/roles/;
const HISTORY_A_ROUTE = /\/api\/agent\/agent-a\/history/;
const HISTORY_B_ROUTE = /\/api\/agent\/agent-b\/history/;

interface TaskRoutes {
  readonly task?: RouteResponse;
  readonly cancel?: RouteResponse;
  readonly start?: RouteResponse;
  readonly pause?: RouteResponse;
  readonly resume?: RouteResponse;
  readonly agents?: RouteResponse;
  readonly assignments?: RouteResponse;
  readonly roles?: RouteResponse;
  readonly historyA?: RouteResponse;
  readonly historyB?: RouteResponse;
}

/**
 * Answers every route the dialog can reach: the task itself, its assignments,
 * the company's roles (for role names), each agent's history, and the cancel
 * route. Both histories default to one row rather than none, so an expanded
 * panel's transcript renders as a real `<ol>`.
 */
const respondTask = (overrides: TaskRoutes = {}): void => {
  respondByRoute([
    [TASK_START_ROUTE, overrides.start ?? { body: taskFixture() }],
    [TASK_PAUSE_ROUTE, overrides.pause ?? { body: taskFixture() }],
    [TASK_RESUME_ROUTE, overrides.resume ?? { body: { resumed: 1 } }],
    [AGENTS_ROUTE, overrides.agents ?? { body: [] }],
    [
      TASK_CANCEL_ROUTE,
      overrides.cancel ?? { body: taskFixture({ status: 'cancelled' }) },
    ],
    [TASK_ROUTE, overrides.task ?? { body: taskFixture() }],
    [
      ASSIGNMENTS_ROUTE,
      overrides.assignments ?? { body: [ASSIGNMENT_A, ASSIGNMENT_B] },
    ],
    [
      ROLES_ROUTE,
      overrides.roles ?? {
        body: [
          roleFixture(ROLE_A_ID, ROLE_A_NAME),
          roleFixture(ROLE_B_ID, ROLE_B_NAME),
        ],
      },
    ],
    [
      HISTORY_A_ROUTE,
      overrides.historyA ?? {
        body: [
          auditEvent(AGENT_A, {
            eventType: 'input',
            payload: { text: 'Hello Sales' },
          }),
        ],
      },
    ],
    [
      HISTORY_B_ROUTE,
      overrides.historyB ?? {
        body: [
          auditEvent(AGENT_B, {
            eventType: 'input',
            payload: { text: 'Hello Legal' },
          }),
        ],
      },
    ],
  ]);
};

/**
 * A real, keyboard-reachable control that opens the dialog — so React Aria's
 * dialog has something to return focus to on close, and StrictMode's double
 * effect invocation is exercised the same way a real page would trigger it.
 */
const Opener = () => {
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  return (
    <>
      <Button
        className="react-aria-Button"
        onPress={() => {
          setOpenTaskId(TASK_ID);
        }}
      >
        Open task
      </Button>
      {openTaskId !== null && (
        <TaskDialog
          taskId={openTaskId}
          companyId={COMPANY_ID}
          onClose={() => {
            setOpenTaskId(null);
          }}
        />
      )}
    </>
  );
};

const renderTaskDialog = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    queryClient,
    ...render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <Opener />
        </QueryClientProvider>
      </StrictMode>,
    ),
  };
};

/** No progressbar anywhere — every open transcript has resolved its history. */
const waitForTranscriptsReady = () =>
  waitFor(() => {
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
  });

const openTask = async (
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> => {
  await user.click(screen.getByRole('button', { name: 'Open task' }));
  await waitForTranscriptsReady();
};

const expandPanel = async (
  user: ReturnType<typeof userEvent.setup>,
  role: string,
): Promise<void> => {
  await user.click(
    screen.getByRole('button', { name: t('task.assignment.expand', { role }) }),
  );
  await waitForTranscriptsReady();
};

const assignmentLabel = (role: string, status: string) =>
  t('task.assignment.label', { role, status: statusLabel(status) });

/** Bodies of every PUT to the task route, as pending text reads. */
const putBodies = (): Promise<string>[] =>
  fetchMock.mock.calls.flatMap(([input]) =>
    input instanceof Request && input.method === 'PUT'
      ? [input.clone().text()]
      : [],
  );

const requestCount = (route: RegExp) =>
  fetchMock.mock.calls.filter(([input]) => {
    const url = input instanceof Request ? input.url : String(input);
    return route.test(url);
  }).length;

describe('TaskDialog', () => {
  beforeEach(() => {
    installFetchMock();
    handles.clear();
    openCounts.clear();
    refusedUrls.clear();

    subscribeMock.mockImplementation((url, onEvent, onError) => {
      if (refusedUrls.has(url)) {
        throw new Error(`Refusing to open event stream ${url}: at capacity`);
      }

      handles.set(url, {
        emit: onEvent,
        fail: onError as (error: Error) => void,
      });
      openCounts.set(url, (openCounts.get(url) ?? 0) + 1);

      let unsubscribed = false;
      return () => {
        if (unsubscribed) return;
        unsubscribed = true;
        openCounts.set(url, (openCounts.get(url) ?? 0) - 1);
      };
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders the task's shortcode, request and status", async () => {
    respondTask();
    const user = userEvent.setup();
    renderTaskDialog();

    await openTask(user);

    const dialog = screen.getByRole('dialog', {
      name: t('task.dialog.heading', { shortcode: 'TASK-1' }),
    });
    expect(
      within(dialog).getByText('Reconcile Q3 accounts'),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(statusLabel('in-progress')),
    ).toBeInTheDocument();
  });

  it('renders one panel per assignment, each named by its role and status', async () => {
    respondTask();
    const user = userEvent.setup();
    renderTaskDialog();

    await openTask(user);

    expect(
      screen.getByRole('region', {
        name: assignmentLabel(ROLE_A_NAME, 'in-progress'),
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', {
        name: assignmentLabel(ROLE_B_NAME, 'ready'),
      }),
    ).toBeInTheDocument();
  });

  it('opens with every panel collapsed', async () => {
    respondTask();
    const user = userEvent.setup();
    renderTaskDialog();

    await openTask(user);

    expect(
      screen.getByRole('button', {
        name: t('task.assignment.expand', { role: ROLE_A_NAME }),
      }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.getByRole('button', {
        name: t('task.assignment.expand', { role: ROLE_B_NAME }),
      }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('list')).toBeNull();
  });

  it("expands one panel to show that agent's transcript, leaving the other collapsed", async () => {
    respondTask();
    const user = userEvent.setup();
    renderTaskDialog();

    await openTask(user);
    await expandPanel(user, ROLE_A_NAME);

    expect(screen.getByText('Hello Sales')).toBeInTheDocument();
    expect(screen.queryByText('Hello Legal')).toBeNull();
    expect(
      screen.getByRole('button', {
        name: t('task.assignment.expand', { role: ROLE_B_NAME }),
      }),
    ).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps two expanded panels separate: a delta on one never reaches the other', async () => {
    respondTask();
    const user = userEvent.setup();
    renderTaskDialog();

    await openTask(user);
    await expandPanel(user, ROLE_A_NAME);
    await expandPanel(user, ROLE_B_NAME);

    act(() => {
      streamFor(streamUrls.agent(AGENT_A)).emit(
        streamDeltaEvent(AGENT_A, 'partial reply'),
      );
    });

    const salesPanel = screen.getByRole('region', {
      name: assignmentLabel(ROLE_A_NAME, 'in-progress'),
    });
    const legalPanel = screen.getByRole('region', {
      name: assignmentLabel(ROLE_B_NAME, 'ready'),
    });
    expect(within(salesPanel).getByText('partial reply')).toBeInTheDocument();
    expect(within(legalPanel).queryByText('partial reply')).toBeNull();
  });

  it("updates an assignment panel's status from a live event on the task stream, without refetching assignments", async () => {
    respondTask();
    const user = userEvent.setup();
    renderTaskDialog();

    await openTask(user);
    const before = requestCount(ASSIGNMENTS_ROUTE);

    act(() => {
      streamFor(streamUrls.task(TASK_ID)).emit(
        assignmentStateChangeEvent({
          id: ASSIGN_A,
          status: 'succeeded',
          mode: 'implement',
          orderIndex: 0,
          roleId: ROLE_A_ID,
        }),
      );
    });

    await screen.findByRole('region', {
      name: assignmentLabel(ROLE_A_NAME, 'succeeded'),
    });
    expect(requestCount(ASSIGNMENTS_ROUTE)).toBe(before);
  });

  it('updates the shown status from a live task event on the task stream', async () => {
    respondTask();
    const user = userEvent.setup();
    renderTaskDialog();

    await openTask(user);

    act(() => {
      streamFor(streamUrls.task(TASK_ID)).emit(
        taskStateChangeEvent({
          id: TASK_ID,
          status: 'finalising',
          request: 'Reconcile Q3 accounts',
          shortcode: 'TASK-1',
        }),
      );
    });

    const dialog = screen.getByRole('dialog', {
      name: t('task.dialog.heading', { shortcode: 'TASK-1' }),
    });
    await within(dialog).findByText(statusLabel('finalising'));
  });

  it('keeps assignment order stable when a status change updates a row in place', async () => {
    respondTask();
    const user = userEvent.setup();
    renderTaskDialog();

    await openTask(user);

    const order = () =>
      screen
        .getAllByRole('button', { name: /has done$/ })
        .map((el) => el.textContent);

    const before = order();

    act(() => {
      streamFor(streamUrls.task(TASK_ID)).emit(
        assignmentStateChangeEvent({
          id: ASSIGN_B,
          status: 'succeeded',
          mode: 'implement',
          orderIndex: 0,
          roleId: ROLE_B_ID,
        }),
      );
    });

    await screen.findByRole('region', {
      name: assignmentLabel(ROLE_B_NAME, 'succeeded'),
    });
    expect(order()).toEqual(before);
  });

  it('shows a loading state while the task is loading', async () => {
    // Never resolved — the assertion happens before it would be.
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    const user = userEvent.setup();
    renderTaskDialog();

    await user.click(screen.getByRole('button', { name: 'Open task' }));

    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('shows an error state when the task fails to load', async () => {
    respondTask({ task: { status: 500, body: { message: 'boom' } } });
    const user = userEvent.setup();
    renderTaskDialog();

    await user.click(screen.getByRole('button', { name: 'Open task' }));

    expect(await screen.findByText(t('task.error'))).toBeInTheDocument();
  });

  it('shows an empty state when the task has no assignments', async () => {
    respondTask({ assignments: { body: [] } });
    const user = userEvent.setup();
    renderTaskDialog();

    await openTask(user);

    expect(
      screen.getByText(t('task.assignments.empty.heading')),
    ).toBeInTheDocument();
  });

  describe('cancelling', () => {
    it('confirms before cancelling, and posts exactly once when confirmed', async () => {
      respondTask();
      const user = userEvent.setup();
      renderTaskDialog();

      await openTask(user);

      await user.click(screen.getByRole('button', { name: t('task.cancel') }));
      const confirmDialog = await screen.findByRole('dialog', {
        name: t('task.cancel.confirm.heading'),
      });
      expect(
        within(confirmDialog).getByText(t('task.cancel.confirm.body')),
      ).toBeInTheDocument();

      await user.click(
        within(confirmDialog).getByRole('button', {
          name: t('task.cancel.confirm.reject'),
        }),
      );
      expect(requestCount(TASK_CANCEL_ROUTE)).toBe(0);

      await user.click(screen.getByRole('button', { name: t('task.cancel') }));
      await user.click(
        screen.getByRole('button', { name: t('task.cancel.confirm.accept') }),
      );

      await waitFor(() => {
        expect(requestCount(TASK_CANCEL_ROUTE)).toBe(1);
      });
    });

    it('has no cancel control for a task that has already finished', async () => {
      respondTask({ task: { body: taskFixture({ status: 'succeeded' }) } });
      const user = userEvent.setup();
      renderTaskDialog();

      await openTask(user);

      expect(
        screen.queryByRole('button', { name: t('task.cancel') }),
      ).toBeNull();
    });

    it('shows an error, and keeps the dialog open, when cancelling fails', async () => {
      respondTask({ cancel: { status: 500, body: { message: 'boom' } } });
      const user = userEvent.setup();
      renderTaskDialog();

      await openTask(user);

      await user.click(screen.getByRole('button', { name: t('task.cancel') }));
      await user.click(
        screen.getByRole('button', { name: t('task.cancel.confirm.accept') }),
      );

      expect(await screen.findByText(t('refusal.server'))).toBeInTheDocument();
      expect(
        screen.getByRole('dialog', {
          name: t('task.dialog.heading', { shortcode: 'TASK-1' }),
        }),
      ).toBeInTheDocument();
    });
  });

  describe('controls', () => {
    const control = (key: StringKey) =>
      screen.queryByRole('button', { name: t(key) });

    it('offers Start and Edit, and not Pause, for a ready task', async () => {
      respondTask({ task: { body: taskFixture({ status: 'ready' }) } });
      const user = userEvent.setup();
      renderTaskDialog();
      await openTask(user);

      expect(control('task.start')).not.toBeNull();
      expect(control('task.edit')).not.toBeNull();
      expect(control('task.pause')).toBeNull();
      expect(control('task.resume')).toBeNull();
    });

    it('offers Pause and Cancel, and not Resume, for a running task', async () => {
      respondTask();
      const user = userEvent.setup();
      renderTaskDialog();
      await openTask(user);

      expect(control('task.pause')).not.toBeNull();
      expect(control('task.cancel')).not.toBeNull();
      expect(control('task.resume')).toBeNull();
      expect(control('task.start')).toBeNull();
    });

    it('offers Resume, and not Pause, for a paused task', async () => {
      respondTask({
        task: { body: taskFixture({ pausedAt: NOW, pausedBy: 'Ada' }) },
      });
      const user = userEvent.setup();
      renderTaskDialog();
      await openTask(user);

      expect(control('task.resume')).not.toBeNull();
      expect(control('task.pause')).toBeNull();
    });

    it('offers none of the four for a finished task', async () => {
      respondTask({ task: { body: taskFixture({ status: 'succeeded' }) } });
      const user = userEvent.setup();
      renderTaskDialog();
      await openTask(user);

      for (const key of [
        'task.start',
        'task.edit',
        'task.pause',
        'task.resume',
      ] as const) {
        expect(control(key)).toBeNull();
      }
    });

    it.each([
      ['task.pause', TASK_PAUSE_ROUTE, {}],
      ['task.start', TASK_START_ROUTE, { status: 'ready' }],
      ['task.resume', TASK_RESUME_ROUTE, { pausedAt: NOW }],
    ] as const)('%s calls its endpoint', async (key, route, overrides) => {
      respondTask({ task: { body: taskFixture(overrides) } });
      const user = userEvent.setup();
      renderTaskDialog();
      await openTask(user);

      await user.click(screen.getByRole('button', { name: t(key) }));

      await waitFor(() => {
        expect(requestCount(route)).toBe(1);
      });
    });

    it('says so when pausing is refused with a 409', async () => {
      respondTask({ pause: { status: 409, body: { message: 'no' } } });
      const user = userEvent.setup();
      renderTaskDialog();
      await openTask(user);

      await user.click(screen.getByRole('button', { name: t('task.pause') }));

      expect(
        await screen.findByText(
          "This task isn't running, or is already paused.",
        ),
      ).toBeInTheDocument();
    });

    it('says who paused it when no agent is still running', async () => {
      respondTask({
        task: { body: taskFixture({ pausedAt: NOW, pausedBy: 'Ada' }) },
        agents: { body: [agentFixture(ASSIGN_A, 'paused')] },
      });
      const user = userEvent.setup();
      renderTaskDialog();
      await openTask(user);

      expect(
        await screen.findByText('Paused by Ada — resume to continue'),
      ).toBeInTheDocument();
    });

    it('says it is pausing while an agent still runs', async () => {
      respondTask({
        task: { body: taskFixture({ pausedAt: NOW, pausedBy: 'Ada' }) },
        agents: { body: [agentFixture(ASSIGN_A, 'running')] },
      });
      const user = userEvent.setup();
      renderTaskDialog();
      await openTask(user);

      expect(
        await screen.findByText(t('task.details.pausing')),
      ).toBeInTheDocument();
    });

    it('moves focus to the details when Start succeeds and the button goes', async () => {
      respondTask({ task: { body: taskFixture({ status: 'ready' }) } });
      const user = userEvent.setup();
      renderTaskDialog();
      await openTask(user);

      respondTask({ task: { body: taskFixture({ status: 'planning' }) } });
      await user.click(screen.getByRole('button', { name: t('task.start') }));

      await waitFor(() => {
        expect(document.activeElement).toBe(
          screen.getByRole('region', { name: t('task.details.label') }),
        );
      });
    });

    // A text expectation set from the CLI must not come back as a filename.
    it("keeps an expected output's type when saving an edit", async () => {
      respondTask({
        task: {
          body: taskFixture({
            status: 'ready',
            expected: [{ type: 'inline-text', value: 'Total: \\d+' }],
          }),
        },
      });
      const user = userEvent.setup();
      renderTaskDialog();
      await openTask(user);

      await user.click(screen.getByRole('button', { name: t('task.edit') }));
      const form = await screen.findByRole('dialog', {
        name: t('task.edit.heading', { shortcode: 'TASK-1' }),
      });
      await user.click(
        within(form).getByRole('button', { name: t('task.edit.submit') }),
      );

      await waitFor(() => {
        expect(putBodies()).toHaveLength(1);
      });
      expect(JSON.parse(await putBodies()[0])).toMatchObject({
        expected: [{ type: 'inline-text', value: 'Total: \\d+' }],
      });
    });

    it('pre-fills the edit form and PUTs only request, planner and expected', async () => {
      respondTask({
        task: {
          body: {
            ...taskFixture({
              status: 'ready',
              expected: [{ type: 'task-completed-path', value: 'out.md' }],
            }),
            plannerRoleId: ROLE_A_ID,
          },
        },
      });
      const user = userEvent.setup();
      renderTaskDialog();
      await openTask(user);

      await user.click(screen.getByRole('button', { name: t('task.edit') }));
      const form = await screen.findByRole('dialog', {
        name: t('task.edit.heading', { shortcode: 'TASK-1' }),
      });
      expect(
        within(form).getByLabelText(t('task.create.request.label'), {
          exact: false,
        }),
      ).toHaveValue('Reconcile Q3 accounts');
      expect(
        within(form).getByLabelText(
          t('task.create.expected.label', { position: 1 }),
          {
            exact: false,
          },
        ),
      ).toHaveValue('out.md');
      expect(
        within(form).queryByLabelText(t('task.create.materials.label')),
      ).toBeNull();
      expect(within(form).queryByText(t('task.create.start.label'))).toBeNull();

      await user.click(
        within(form).getByRole('button', { name: t('task.edit.submit') }),
      );

      await waitFor(() => {
        expect(putBodies()).toHaveLength(1);
      });
      expect(JSON.parse(await putBodies()[0])).toEqual({
        request: 'Reconcile Q3 accounts',
        plannerRoleId: ROLE_A_ID,
        expected: [{ type: 'task-completed-path', value: 'out.md' }],
      });
      await waitFor(() => {
        expect(
          screen.queryByRole('dialog', {
            name: t('task.edit.heading', { shortcode: 'TASK-1' }),
          }),
        ).toBeNull();
      });
    });

    it('has no accessibility violations in the paused state', async () => {
      respondTask({
        task: { body: taskFixture({ pausedAt: NOW, pausedBy: 'Ada' }) },
        agents: { body: [agentFixture(ASSIGN_A, 'paused')] },
      });
      const user = userEvent.setup();
      renderTaskDialog();
      await openTask(user);
      await screen.findByText('Paused by Ada — resume to continue');

      await expectNoA11yViolations(document.body);
    });
  });

  it('shows at-capacity for a panel refused by the connection cap, while its sibling keeps working', async () => {
    respondTask();
    refusedUrls.add(streamUrls.agent(AGENT_B));
    const user = userEvent.setup();
    renderTaskDialog();

    await openTask(user);
    await expandPanel(user, ROLE_A_NAME);
    await expandPanel(user, ROLE_B_NAME);

    expect(screen.getByText('Hello Sales')).toBeInTheDocument();
    expect(
      screen.getByText(t('transcript.error.atCapacity')),
    ).toBeInTheDocument();
  });

  /**
   * Where focus goes, which for this dialog is four separate decisions.
   *
   * ADR-027 forbids leaving focus on `document.body`, which is where it lands
   * whenever a focused element is removed and nobody says where it should go
   * instead. Two of these are React Aria's own behaviour rather than this
   * component's — asserted anyway, because the design depends on them and
   * nothing else in this file would notice them changing.
   */
  describe('focus', () => {
    const opener = () => screen.getByRole('button', { name: 'Open task' });

    const detailsSection = () =>
      screen.getByRole('region', { name: t('task.details.label') });

    it('returns to the control that opened the dialog when it closes', async () => {
      respondTask();
      const user = userEvent.setup();
      renderTaskDialog();

      await openTask(user);
      await user.click(screen.getByRole('button', { name: t('dialog.close') }));

      // React Aria's own doing: `ModalOverlay` restores focus to whatever
      // opened it when the overlay unmounts. There is no dock here to take
      // the last word off it, so the trigger is where focus ends up.
      await waitFor(() => {
        expect(document.activeElement).toBe(opener());
      });
    });

    it('returns to the cancel button when the confirmation is dismissed', async () => {
      respondTask();
      const user = userEvent.setup();
      renderTaskDialog();

      await openTask(user);
      await user.click(screen.getByRole('button', { name: t('task.cancel') }));
      await screen.findByRole('dialog', {
        name: t('task.cancel.confirm.heading'),
      });
      await user.click(
        screen.getByRole('button', { name: t('task.cancel.confirm.reject') }),
      );

      // `waitFor`, because the restore happens a turn after the nested
      // overlay unmounts rather than in the same commit.
      await waitFor(() => {
        expect(document.activeElement).toBe(
          screen.getByRole('button', { name: t('task.cancel') }),
        );
      });
    });

    it('lands on the details section when the cancel button disappears', async () => {
      respondTask();
      const user = userEvent.setup();
      renderTaskDialog();

      await openTask(user);
      await user.click(screen.getByRole('button', { name: t('task.cancel') }));
      await screen.findByRole('dialog', {
        name: t('task.cancel.confirm.heading'),
      });

      // `useCancelTask` invalidates rather than writing its own response into
      // the cache, so it is the *refetch* that has to report the task as no
      // longer cancellable. Swapped here, after the confirmation is open and
      // before it is accepted, so the next GET answers differently.
      respondTask({ task: { body: taskFixture({ status: 'cancelled' }) } });

      await user.click(
        screen.getByRole('button', { name: t('task.cancel.confirm.accept') }),
      );

      // The button that was pressed is gone, and its own section is what is
      // left to read — not the page body, which announces nothing.
      await waitFor(() => {
        expect(document.activeElement).toBe(detailsSection());
      });
      expect(document.activeElement).not.toBe(document.body);
    });

    it('stays on a panel toggle when that panel is collapsed', async () => {
      respondTask();
      const user = userEvent.setup();
      renderTaskDialog();

      await openTask(user);
      await expandPanel(user, ROLE_A_NAME);

      const toggle = screen.getByRole('button', {
        name: t('task.assignment.collapse', { role: ROLE_A_NAME }),
      });
      await user.click(toggle);

      // Collapsing destroys a transcript that may have held focus-bearing
      // content. Nothing here moves focus on purpose; the assertion is that
      // nothing moves it by accident either.
      expect(document.activeElement).toBe(
        screen.getByRole('button', {
          name: t('task.assignment.expand', { role: ROLE_A_NAME }),
        }),
      );
      expect(toggle).toBe(document.activeElement);
    });
  });

  /**
   * What a screen reader hears, which for this dialog is one phrase per real
   * change and nothing else.
   *
   * A task dialog can have two transcripts streaming beneath a status line
   * that is itself changing, so it is the surface where an over-eager
   * announcer would be loudest. ADR-027's rules applied here: nothing on
   * arrival, nothing for a partial response, and one polite phrase naming
   * what actually changed.
   */
  describe('announcements', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(async () => {
      await virtual.stop();
      vi.useRealTimers();
    });

    it('says nothing when the dialog opens with two assignments', async () => {
      respondTask();
      const user = userEvent.setup();
      renderTaskDialog();
      await openTask(user);

      // Started after mount on purpose: the seeding pass must announce
      // nothing, and a listener attached before mount could not tell a silent
      // seed from a seed whose phrases were spoken before it was listening.
      await virtual.start({ container: document.body });
      await virtual.clearSpokenPhraseLog();

      await vi.advanceTimersByTimeAsync(15_000);

      expect(await virtual.spokenPhraseLog()).toEqual([]);
    });

    it('says nothing while two responses stream at once', async () => {
      respondTask();
      const user = userEvent.setup();
      renderTaskDialog();
      await openTask(user);
      await expandPanel(user, ROLE_A_NAME);
      await expandPanel(user, ROLE_B_NAME);

      await virtual.start({ container: document.body });
      await virtual.clearSpokenPhraseLog();

      for (const token of 'one token at a time, on both'.split(' ')) {
        act(() => {
          streamFor(streamUrls.agent(AGENT_A)).emit(
            streamDeltaEvent(AGENT_A, `${token} `),
          );
          streamFor(streamUrls.agent(AGENT_B)).emit(
            streamDeltaEvent(AGENT_B, `${token} `),
          );
        });
      }
      // Well past the announcer's throttle, so anything coalescing would have
      // been spoken by now.
      await vi.advanceTimersByTimeAsync(15_000);

      expect(await virtual.spokenPhraseLog()).toEqual([]);
    });

    it("announces one assignment's status change, naming its role", async () => {
      respondTask();
      const user = userEvent.setup();
      renderTaskDialog();
      await openTask(user);

      await virtual.start({ container: document.body });
      await virtual.clearSpokenPhraseLog();

      act(() => {
        streamFor(streamUrls.task(TASK_ID)).emit(
          assignmentStateChangeEvent({
            id: ASSIGN_A,
            status: 'succeeded',
            mode: 'implement',
            orderIndex: 0,
            roleId: ROLE_A_ID,
          }),
        );
      });
      await vi.advanceTimersByTimeAsync(15_000);

      // One phrase, and it names the role: the panel it belongs to is one of
      // several, and "Succeeded" alone would not say which.
      expect(await virtual.spokenPhraseLog()).toEqual([
        `polite: ${t('task.announce.assignment', {
          role: ROLE_A_NAME,
          status: statusLabel('succeeded'),
        })}`,
      ]);
    });

    it("announces the task's own status change on the same channel", async () => {
      respondTask();
      const user = userEvent.setup();
      renderTaskDialog();
      await openTask(user);

      await virtual.start({ container: document.body });
      await virtual.clearSpokenPhraseLog();

      act(() => {
        streamFor(streamUrls.task(TASK_ID)).emit(
          taskStateChangeEvent({
            id: TASK_ID,
            status: 'cancelled',
            request: 'Reconcile Q3 accounts',
            shortcode: 'TASK-1',
          }),
        );
      });
      await vi.advanceTimersByTimeAsync(15_000);

      // `task:<id>` carries both the task's changes and its assignments', so
      // a burst affecting several of them is read as one sentence rather than
      // as several interleaved ones.
      expect(await virtual.spokenPhraseLog()).toEqual([
        `polite: ${t('task.announce.status', {
          status: statusLabel('cancelled'),
        })}`,
      ]);
    });
  });

  describe('accessibility', () => {
    it('has no violations with every panel collapsed', async () => {
      respondTask();
      const user = userEvent.setup();
      renderTaskDialog();

      await openTask(user);

      // React Aria's `Modal` portals out of the render container, so the scan
      // has to cover `document.body` — same reasoning as `DockProvider.test.tsx`.
      await expectNoA11yViolations(document.body);
    });

    it('has no violations with every panel expanded', async () => {
      respondTask();
      const user = userEvent.setup();
      renderTaskDialog();

      await openTask(user);
      await expandPanel(user, ROLE_A_NAME);
      await expandPanel(user, ROLE_B_NAME);

      // Two transcripts under one dialog is the state most likely to go
      // wrong: two lists, two headings, and one set of ids to keep distinct.
      await expectNoA11yViolations(document.body);
    });

    it('has no violations while the cancel confirmation is showing', async () => {
      respondTask();
      const user = userEvent.setup();
      renderTaskDialog();

      await openTask(user);
      await user.click(screen.getByRole('button', { name: t('task.cancel') }));
      await screen.findByRole('dialog', {
        name: t('task.cancel.confirm.heading'),
      });

      // A dialog inside a dialog, which is the arrangement that most often
      // leaves the outer one reachable when it should be inert.
      await expectNoA11yViolations(document.body);
    });
  });

  /**
   * The connection budget, as recorded beside `MAX_STREAMS` in
   * `src/events/subscriptions.ts`: one stream per mounted transcript,
   * collapsing an assignment panel releases its connection, expanding it again
   * re-primes from history. Those rules are applied here rather than
   * re-decided.
   *
   * These are tests for that decision rather than for this component, and this
   * is the surface it was written for: a task can fan out to more assignments
   * than the cap allows streams, so a dialog that held a connection for every
   * panel — including the collapsed ones nobody is looking at — would refuse
   * the panel the user actually opened.
   */
  describe('the connection budget', () => {
    const openStreams = () =>
      [...openCounts.values()].reduce((a, b) => a + b, 0);

    it('opens exactly one stream for a dialog whose panels are all collapsed', async () => {
      respondTask();
      const user = userEvent.setup();
      renderTaskDialog();

      await openTask(user);

      // The task's own stream, and nothing else: it carries this task's
      // changes and its assignments', so a collapsed panel needs no
      // connection of its own to keep its status current.
      expect(openCounts.get(streamUrls.task(TASK_ID))).toBe(1);
      expect(openStreams()).toBe(1);
    });

    it('opens one more stream per expanded panel', async () => {
      respondTask();
      const user = userEvent.setup();
      renderTaskDialog();

      await openTask(user);
      await expandPanel(user, ROLE_A_NAME);
      await expandPanel(user, ROLE_B_NAME);

      // One per mounted transcript, not one per component: the panel heading
      // and its status read the query cache the task stream patches.
      expect(openCounts.get(streamUrls.agent(AGENT_A))).toBe(1);
      expect(openCounts.get(streamUrls.agent(AGENT_B))).toBe(1);
      expect(openStreams()).toBe(3);
    });

    it("releases a collapsed panel's connection, and re-primes when it reopens", async () => {
      respondTask();
      const user = userEvent.setup();
      renderTaskDialog();

      await openTask(user);
      await expandPanel(user, ROLE_A_NAME);
      await expandPanel(user, ROLE_B_NAME);

      await user.click(
        screen.getByRole('button', {
          name: t('task.assignment.collapse', { role: ROLE_A_NAME }),
        }),
      );

      // Collapsing unmounts the transcript, which is what releases the
      // stream. Its sibling keeps its own.
      expect(openCounts.get(streamUrls.agent(AGENT_A))).toBe(0);
      expect(openCounts.get(streamUrls.agent(AGENT_B))).toBe(1);
      expect(openStreams()).toBe(2);

      const before = requestCount(HISTORY_A_ROUTE);
      await expandPanel(user, ROLE_A_NAME);

      // This is the catch-up path, and the only one there is: nothing is held
      // across the collapse, so a reopened panel learns what it missed by
      // asking the server again. No `staleTime` anywhere in `endpoints.ts` is
      // what makes a remount refetch.
      expect(openCounts.get(streamUrls.agent(AGENT_A))).toBe(1);
      expect(openStreams()).toBe(3);
      expect(requestCount(HISTORY_A_ROUTE)).toBeGreaterThan(before);
    });
  });
});
