import { virtual } from '@guidepup/virtual-screen-reader';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WireEvent } from '@tcp/shared/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANNOUNCE_IMMEDIATE_MS,
  ANNOUNCE_THROTTLE_MS,
  resetAnnouncer,
} from '../../../announce/announcer';
import { ChatProvider } from '../../../components/ChatDialog/ChatProvider';
import { DockProvider } from '../../../components/Dialog/DockProvider';
import { applyEvent } from '../../../events/cache';
import { t, type StringKey } from '../../../strings';
import { expectNoA11yViolations } from '../../../test-support/axe';
import {
  fetchMock,
  installFetchMock,
  requestedUrls,
  respondByRoute,
  type RouteResponse,
} from '../../../test-support/fetch-mock';
import { CompanyActivity } from './CompanyActivity';

// The chats list (008.02) opens the chat dialog through `useChat()`, which
// throws outside a `ChatProvider` — and `ChatProvider` needs a `DockProvider`
// above it to park a minimised chat. Neither test in this file drives a real
// event stream (they patch the cache directly through `applyEvent`), so
// `subscribe` is stubbed rather than mocked in detail: opening a chat row
// mounts a `Transcript`, which would otherwise try to open a real connection
// through `connect()` and the auth stack this file never sets up.
vi.mock('../../../events/subscriptions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../events/subscriptions')>()),
  subscribe: vi.fn(() => () => undefined),
}));

const COMPANY_ID = 'company-1';
const NOW = '2026-08-08T00:00:00.000Z';

// Route patterns for `respondByRoute`. `ROLES_ROUTE` is ordered first
// wherever it appears alongside a broader company pattern — see the note on
// `respondByRoute` in `fetch-mock.ts`.
const ROLES_ROUTE = /\/api\/company\/[^/]+\/roles/;
const AGENTS_ROUTE = /\/api\/agent\?/;
const TASKS_ROUTE = /\/api\/task\?/;
// Chats and consultations are both assignments, so both hit `/api/assignment?…`
// — `CHATS_ROUTE` has to be more specific and precede `ASSIGNMENTS_ROUTE`
// wherever the two appear together, the same reasoning as `ROLES_ROUTE` above.
const CHATS_ROUTE = /\/api\/assignment\?.*mode=chat/;
const ASSIGNMENTS_ROUTE = /\/api\/assignment\?/;
const CONVERSATIONS_ROUTE = /\/api\/conversation\?/;
// The chats list opens the chat dialog on a row's agent, which mounts a
// `Transcript` and a `MessageInput` for `CHAT_1.agentId` — a detail and a
// history request neither of `CompanyActivity`'s own five queries make.
const CHAT_AGENT_ROUTE = /\/api\/agent\/agent-9(\?|$)/;
const CHAT_AGENT_HISTORY_ROUTE = /\/api\/agent\/agent-9\/history/;

const ROLE = {
  id: 'role-1',
  name: 'Analyst',
  slug: 'analyst',
  description: 'd',
};

/** A second role, so two agent rows can be told apart by their control's name. */
const ROLE_2 = {
  id: 'role-2',
  name: 'Auditor',
  slug: 'auditor',
  description: 'd',
};

interface AgentOverrides {
  readonly id: string;
  readonly status: string;
  readonly roleId?: string;
  readonly initialPrompt?: string;
}

const agent = (overrides: AgentOverrides) => ({
  id: overrides.id,
  companyId: COMPANY_ID,
  roleId: overrides.roleId ?? ROLE.id,
  assignmentId: null,
  status: overrides.status,
  initialPrompt: overrides.initialPrompt ?? `${overrides.id} initial prompt`,
  threadId: null,
  createdAt: NOW,
  updatedAt: NOW,
  output: null,
});

interface TaskOverrides {
  readonly id: string;
  readonly status: string;
  readonly shortcode?: string;
  readonly request?: string;
}

const task = (overrides: TaskOverrides) => ({
  id: overrides.id,
  companyId: COMPANY_ID,
  request: overrides.request ?? `${overrides.id} request`,
  shortcode: overrides.shortcode ?? overrides.id.toUpperCase(),
  status: overrides.status,
  plannerRoleId: null,
  materials: [],
  expected: [],
  completed: null,
});

/** A `TaskChangeSummary`, built from the task it patches so the two agree. */
const taskSummary = (overrides: {
  id: string;
  status: string;
  request: string;
  shortcode: string;
}) => ({
  ...overrides,
  createdAt: NOW,
  updatedAt: NOW,
  completedSteps: 0,
  totalSteps: 0,
});

interface AssignmentOverrides {
  readonly id: string;
  readonly status: string;
  readonly roleId?: string;
  readonly prompt?: string;
  /** Defaults to `'consultee'` — every fixture before the chats list needed. */
  readonly mode?: string;
  /** Omitted (rather than defaulted) so a chat row missing one can be built. */
  readonly agentId?: string;
  readonly shortcode?: string;
}

const assignment = (overrides: AssignmentOverrides) => ({
  id: overrides.id,
  companyId: COMPANY_ID,
  mode: overrides.mode ?? 'consultee',
  prompt: overrides.prompt ?? `${overrides.id} prompt`,
  roleId: overrides.roleId ?? ROLE.id,
  status: overrides.status,
  taskId: null,
  agentId: overrides.agentId,
  shortcode: overrides.shortcode,
});

interface ConversationOverrides {
  readonly id: string;
  readonly status: string;
  readonly slug?: string;
  readonly roleName?: string;
  readonly roleId?: string;
  readonly agentId?: string;
  readonly question?: string;
}

const conversation = (overrides: ConversationOverrides) => ({
  id: overrides.id,
  slug: overrides.slug ?? overrides.id,
  companyId: COMPANY_ID,
  roleName: overrides.roleName ?? ROLE.name,
  roleId: overrides.roleId ?? ROLE.id,
  agentId: overrides.agentId ?? 'agent-1',
  question: overrides.question ?? `${overrides.id} question`,
  context: null,
  status: overrides.status,
  routedToIdentifiers: [],
  createdAt: NOW,
});

/** An `EnquiryChangeSummary`, built from the conversation it patches. */
const enquirySummary = (overrides: {
  id: string;
  slug: string;
  status: string;
  roleName: string;
  question: string;
}) => ({ ...overrides, createdAt: NOW });

/** An `AssignmentChangeSummary`, built from the assignment it patches. */
const assignmentSummary = (overrides: {
  id: string;
  status: string;
  roleId: string;
}) => ({ ...overrides, mode: 'consultee', orderIndex: null });

const AGENT_1 = agent({
  id: 'agent-1',
  status: 'running',
  initialPrompt: 'Investigate the ledger discrepancy',
});
const TASK_1 = task({
  id: 'task-1',
  status: 'ready',
  shortcode: 'TASK-1',
  request: 'Reconcile Q3 accounts',
});
const ASSIGNMENT_1 = assignment({ id: 'assignment-1', status: 'ready' });
const CONVERSATION_1 = conversation({
  id: 'conv-1',
  status: 'awaiting_user',
  question: 'Which vendor should get priority?',
});
const CHAT_1 = assignment({
  id: 'chat-1',
  status: 'in-progress',
  mode: 'chat',
  agentId: 'agent-9',
});
/** The agent `CHAT_1` names, fetched when a row opens the chat dialog. */
const CHAT_AGENT = agent({ id: 'agent-9', status: 'idle' });
/** A completed chat, same role as `CHAT_1` — hidden by the default status filter. */
const CHAT_COMPLETED = assignment({
  id: 'chat-completed',
  status: 'succeeded',
  mode: 'chat',
  agentId: 'agent-10',
});
/** An open chat under `ROLE_2`, for the role filter's tests. */
const CHAT_OTHER_ROLE = assignment({
  id: 'chat-other-role',
  status: 'in-progress',
  mode: 'chat',
  roleId: ROLE_2.id,
  agentId: 'agent-11',
});

interface ActivityRoutes {
  readonly roles?: RouteResponse;
  readonly agents?: RouteResponse;
  readonly tasks?: RouteResponse;
  readonly assignments?: RouteResponse;
  readonly conversations?: RouteResponse;
  readonly chats?: RouteResponse;
}

/** Answers all six queries `CompanyActivity` mounts. Each is overridable. */
const respondActivity = (overrides: ActivityRoutes = {}): void => {
  respondByRoute([
    [ROLES_ROUTE, overrides.roles ?? { body: [ROLE] }],
    [AGENTS_ROUTE, overrides.agents ?? { body: [AGENT_1] }],
    [TASKS_ROUTE, overrides.tasks ?? { body: [TASK_1] }],
    [CHATS_ROUTE, overrides.chats ?? { body: [CHAT_1] }],
    [ASSIGNMENTS_ROUTE, overrides.assignments ?? { body: [ASSIGNMENT_1] }],
    [
      CONVERSATIONS_ROUTE,
      overrides.conversations ?? { body: [CONVERSATION_1] },
    ],
    // Not overridable per test — nothing here exercises more than one chat
    // agent, so a fixed fixture is enough.
    [CHAT_AGENT_HISTORY_ROUTE, { body: [] }],
    [CHAT_AGENT_ROUTE, { body: CHAT_AGENT }],
  ]);
};

const EMPTY_ROUTES: ActivityRoutes = {
  roles: { body: [] },
  agents: { body: [] },
  tasks: { body: [] },
  assignments: { body: [] },
  conversations: { body: [] },
  chats: { body: [] },
};

const renderActivity = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          {/*
            The chats list (008.02) calls `useChat()`, which throws outside a
            `ChatProvider` — and a parked chat needs a `DockProvider` above
            that. Both wrap here in the same order `AppShell` mounts them.
          */}
          <DockProvider>
            <ChatProvider>
              <CompanyActivity companyId={COMPANY_ID} />
            </ChatProvider>
          </DockProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
};

/** A live `state_change` audit event, as `useEventStream` hands to `applyEvent`. */
const auditEvent = (
  payload: Record<string, unknown>,
  agentId: string | null = null,
): WireEvent => ({
  type: 'audit',
  event: {
    timestamp: NOW,
    companyId: COMPANY_ID,
    role: 'system',
    agentId,
    assignmentId: null,
    taskId: null,
    eventType: 'state_change',
    payload,
  },
});

const listen = async () => {
  await virtual.start({ container: document.body });
  await virtual.clearSpokenPhraseLog();
};

/** Long enough for any open announcement window to have flushed. */
const settle = () => vi.advanceTimersByTimeAsync(ANNOUNCE_THROTTLE_MS * 2);

const ACTIVE_FILTER_LABELS: readonly StringKey[] = [
  'activity.status.ready',
  'activity.status.planning',
  'activity.status.in-progress',
  'activity.status.finalising',
];

describe('CompanyActivity', () => {
  beforeEach(() => {
    installFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the four lists as labelled regions, each showing its own count', async () => {
    respondActivity();
    renderActivity();

    const headings = [
      t('activity.agents.heading'),
      t('activity.tasks.heading'),
      t('activity.consultations.heading'),
      t('activity.enquiries.heading'),
    ];

    for (const heading of headings) {
      const region = await screen.findByRole('region', { name: heading });
      // The region itself renders before its data does — `getByRole` finds it
      // mid-load — so the count has to be awaited separately.
      expect(
        await within(region).findByText(t('activity.count', { count: 1 })),
      ).toBeInTheDocument();
    }

    // Five now, not four: the chats list (008.02) is a fifth region, covered
    // in its own describe block below rather than in this loop.
    expect(screen.getAllByRole('region')).toHaveLength(5);
  });

  it("renders each row's key fields", async () => {
    respondActivity();
    renderActivity();

    const agentsRegion = await screen.findByRole('region', {
      name: t('activity.agents.heading'),
    });
    // Waits for the roles fetch, through which the row resolves its role name.
    expect(
      await within(agentsRegion).findByText(ROLE.name),
    ).toBeInTheDocument();
    expect(
      within(agentsRegion).getByText(AGENT_1.initialPrompt),
    ).toBeInTheDocument();

    const tasksRegion = screen.getByRole('region', {
      name: t('activity.tasks.heading'),
    });
    expect(within(tasksRegion).getByText(TASK_1.shortcode)).toBeInTheDocument();
    expect(within(tasksRegion).getByText(TASK_1.request)).toBeInTheDocument();

    const consultationsRegion = screen.getByRole('region', {
      name: t('activity.consultations.heading'),
    });
    expect(
      within(consultationsRegion).getByText(ROLE.name),
    ).toBeInTheDocument();

    const enquiriesRegion = screen.getByRole('region', {
      name: t('activity.enquiries.heading'),
    });
    expect(
      within(enquiriesRegion).getByText(CONVERSATION_1.roleName),
    ).toBeInTheDocument();
    expect(
      within(enquiriesRegion).getByText(CONVERSATION_1.question),
    ).toBeInTheDocument();
  });

  it('excludes terminal rows from every list', async () => {
    respondActivity({
      agents: {
        body: [
          agent({ id: 'agent-1', status: 'running' }),
          agent({ id: 'agent-2', status: 'completed' }),
        ],
      },
      tasks: {
        body: [
          TASK_1,
          task({ id: 'task-2', status: 'succeeded', shortcode: 'TASK-2' }),
        ],
      },
      assignments: {
        body: [
          ASSIGNMENT_1,
          assignment({ id: 'assignment-2', status: 'succeeded' }),
        ],
      },
      conversations: {
        // The query already asked for `?status=awaiting_user`; a closed row
        // in the fixture is what proves the client-side filter, not the
        // query parameter, keeps it out.
        body: [
          CONVERSATION_1,
          conversation({
            id: 'conv-2',
            status: 'closed',
            question: 'Already answered?',
          }),
        ],
      },
    });
    renderActivity();

    const agentsRegion = await screen.findByRole('region', {
      name: t('activity.agents.heading'),
    });
    await within(agentsRegion).findByText(t('activity.count', { count: 1 }));

    const tasksRegion = screen.getByRole('region', {
      name: t('activity.tasks.heading'),
    });
    expect(within(tasksRegion).getByText(TASK_1.shortcode)).toBeInTheDocument();
    expect(within(tasksRegion).queryByText('TASK-2')).not.toBeInTheDocument();

    const consultationsRegion = screen.getByRole('region', {
      name: t('activity.consultations.heading'),
    });
    expect(
      within(consultationsRegion).getByText(t('activity.count', { count: 1 })),
    ).toBeInTheDocument();

    const enquiriesRegion = screen.getByRole('region', {
      name: t('activity.enquiries.heading'),
    });
    expect(
      within(enquiriesRegion).getByText(CONVERSATION_1.question),
    ).toBeInTheDocument();
    expect(
      within(enquiriesRegion).queryByText('Already answered?'),
    ).not.toBeInTheDocument();
  });

  describe('live stream events', () => {
    it('removes a task from the list when a stream event changes it to a terminal status', async () => {
      respondActivity({ tasks: { body: [TASK_1] } });
      const { queryClient } = renderActivity();

      await screen.findByText(TASK_1.shortcode);

      act(() => {
        applyEvent(
          queryClient,
          auditEvent({
            entity: 'task',
            summary: taskSummary({
              id: TASK_1.id,
              status: 'succeeded',
              request: TASK_1.request,
              shortcode: TASK_1.shortcode,
            }),
          }),
        );
      });

      await waitFor(() => {
        expect(screen.queryByText(TASK_1.shortcode)).not.toBeInTheDocument();
      });
    });

    it('removes a consultation from the list when a stream event changes it to a terminal status', async () => {
      respondActivity({ assignments: { body: [ASSIGNMENT_1] } });
      const { queryClient } = renderActivity();

      const consultationsRegion = await screen.findByRole('region', {
        name: t('activity.consultations.heading'),
      });
      await within(consultationsRegion).findByText(
        t('activity.count', { count: 1 }),
      );

      act(() => {
        applyEvent(
          queryClient,
          auditEvent({
            entity: 'assignment',
            summary: assignmentSummary({
              id: ASSIGNMENT_1.id,
              status: 'succeeded',
              roleId: ASSIGNMENT_1.roleId,
            }),
          }),
        );
      });

      await waitFor(() => {
        expect(
          within(consultationsRegion).getByText(
            t('activity.count', { count: 0 }),
          ),
        ).toBeInTheDocument();
      });
    });

    it('shows a cached task once a stream event brings its status into the filter', async () => {
      const hidden = task({
        id: 'task-2',
        status: 'succeeded',
        shortcode: 'TASK-2',
        request: 'Archive old logs',
      });
      respondActivity({ tasks: { body: [TASK_1, hidden] } });
      const { queryClient } = renderActivity();

      await screen.findByText(TASK_1.shortcode);
      expect(screen.queryByText(hidden.shortcode)).not.toBeInTheDocument();

      act(() => {
        applyEvent(
          queryClient,
          auditEvent({
            entity: 'task',
            summary: taskSummary({
              id: hidden.id,
              status: 'ready',
              request: hidden.request,
              shortcode: hidden.shortcode,
            }),
          }),
        );
      });

      const tasksRegion = screen.getByRole('region', {
        name: t('activity.tasks.heading'),
      });
      const shortcodeCell = await within(tasksRegion).findByText(
        hidden.shortcode,
      );
      const row = shortcodeCell.closest('li');
      if (row === null) throw new Error('row not found');
      // `TASK_1` is also `ready`, so scope to this row rather than asserting
      // the status text exists anywhere in the list.
      expect(
        within(row).getByText(t('activity.status.ready')),
      ).toBeInTheDocument();
    });

    it('removes an agent from the list on a status-change event with no summary', async () => {
      // 002.04's writers publish an agent `state_change` with no `summary` —
      // `cache.ts`'s `synthesiseAgentPatch` reconstructs `{ id, status }` from
      // the envelope's `agentId` and the payload's `newStatus` instead. This
      // is the only test exercising that path end to end.
      respondActivity({
        agents: { body: [agent({ id: 'agent-1', status: 'running' })] },
      });
      const { queryClient } = renderActivity();

      const agentsRegion = await screen.findByRole('region', {
        name: t('activity.agents.heading'),
      });
      await within(agentsRegion).findByText(t('activity.count', { count: 1 }));

      act(() => {
        applyEvent(
          queryClient,
          auditEvent({ entity: 'agent', newStatus: 'completed' }, 'agent-1'),
        );
      });

      expect(
        await within(agentsRegion).findByText(
          t('activity.count', { count: 0 }),
        ),
      ).toBeInTheDocument();
    });

    it('removes an enquiry from the list when a stream event closes it', async () => {
      respondActivity({ conversations: { body: [CONVERSATION_1] } });
      const { queryClient } = renderActivity();

      await screen.findByText(CONVERSATION_1.question);

      act(() => {
        applyEvent(
          queryClient,
          auditEvent({
            entity: 'enquiry',
            summary: enquirySummary({
              id: CONVERSATION_1.id,
              slug: CONVERSATION_1.slug,
              status: 'closed',
              roleName: CONVERSATION_1.roleName,
              question: CONVERSATION_1.question,
            }),
          }),
        );
      });

      await waitFor(() => {
        expect(
          screen.queryByText(CONVERSATION_1.question),
        ).not.toBeInTheDocument();
      });
    });

    it('keeps task order stable when a status change updates a row in place', async () => {
      const tasks = [
        task({ id: 'task-1', status: 'ready', shortcode: 'TASK-1' }),
        task({ id: 'task-2', status: 'ready', shortcode: 'TASK-2' }),
        task({ id: 'task-3', status: 'ready', shortcode: 'TASK-3' }),
      ];
      respondActivity({ tasks: { body: tasks } });
      const { queryClient } = renderActivity();

      const tasksRegion = await screen.findByRole('region', {
        name: t('activity.tasks.heading'),
      });
      await within(tasksRegion).findByText('TASK-1');

      const before = within(tasksRegion)
        .getAllByText(/^TASK-\d$/)
        .map((el) => el.textContent);

      // The middle task's status changes but stays inside the default
      // filter (`planning` is active) — ADR-027 says a status change updates
      // the row in place, it does not re-sort the list out from under
      // someone reading it.
      act(() => {
        applyEvent(
          queryClient,
          auditEvent({
            entity: 'task',
            summary: taskSummary({
              id: 'task-2',
              status: 'planning',
              request: tasks[1].request,
              shortcode: tasks[1].shortcode,
            }),
          }),
        );
      });

      await within(tasksRegion).findByText(t('activity.status.planning'));

      const after = within(tasksRegion)
        .getAllByText(/^TASK-\d$/)
        .map((el) => el.textContent);
      expect(after).toEqual(before);
    });
  });

  describe("the agents list's prompt excerpt", () => {
    // Comfortably under `AgentsList`'s `PROMPT_EXCERPT_LENGTH` (160), so it is
    // shown whole and gets no control.
    const SHORT_PROMPT = 'Check last week’s invoices';
    // Comfortably over it, with plenty of word boundaries near the cut.
    const LONG_PROMPT =
      'Investigate the ledger discrepancy reported in the September close, tracing every journal entry back to the source document that raised it, and write up what you find for the finance team before the audit begins.';
    const OTHER_LONG_PROMPT =
      'Review the supplier contracts renewed this quarter, list every clause that changed against the previous version, and flag the ones that alter payment terms so the finance team can price them before renewal.';

    const expandName = (role: string) =>
      t('activity.agents.prompt.expand', { role });
    const collapseName = (role: string) =>
      t('activity.agents.prompt.collapse', { role });

    /**
     * The paragraph an expander controls, resolved the way assistive tech
     * would — through `aria-controls`, which therefore has to point at
     * something real for this to work at all.
     */
    const controlledPrompt = (control: HTMLElement): HTMLElement => {
      const id = control.getAttribute('aria-controls');
      if (id === null) throw new Error('the control has no aria-controls');
      const target = document.getElementById(id);
      if (target === null) throw new Error('aria-controls names no element');
      return target;
    };

    const agentsRegion = () =>
      screen.findByRole('region', { name: t('activity.agents.heading') });

    it('renders a short prompt whole, with no control at all', async () => {
      respondActivity({
        agents: {
          body: [
            agent({
              id: 'agent-1',
              status: 'running',
              initialPrompt: SHORT_PROMPT,
            }),
          ],
        },
      });
      renderActivity();

      const region = await agentsRegion();
      expect(await within(region).findByText(SHORT_PROMPT)).toBeInTheDocument();
      expect(
        within(region).queryByRole('button', { name: expandName(ROLE.name) }),
      ).not.toBeInTheDocument();
    });

    it('clips a long prompt to a real excerpt, leaving the rest out of the DOM', async () => {
      respondActivity({
        agents: {
          body: [
            agent({
              id: 'agent-1',
              status: 'running',
              initialPrompt: LONG_PROMPT,
            }),
          ],
        },
      });
      renderActivity();

      const region = await agentsRegion();
      const control = await within(region).findByRole('button', {
        name: expandName(ROLE.name),
      });
      expect(control).toHaveAttribute('aria-expanded', 'false');

      const shown = controlledPrompt(control).textContent ?? '';
      // An excerpt of this prompt, not a stand-in for it: what is shown is the
      // prompt's own opening, marked as unfinished.
      expect(shown.endsWith('…')).toBe(true);
      expect(LONG_PROMPT.startsWith(shown.slice(0, -1))).toBe(true);
      expect(shown.length).toBeLessThan(LONG_PROMPT.length);
      // The saving is only real if the rest is genuinely absent — a screen
      // reader reads the DOM, not what CSS has clipped.
      expect(within(region).queryByText(LONG_PROMPT)).not.toBeInTheDocument();
    });

    it('reveals the full prompt from the keyboard, and reports its new state', async () => {
      respondActivity({
        agents: {
          body: [
            agent({
              id: 'agent-1',
              status: 'running',
              initialPrompt: LONG_PROMPT,
            }),
          ],
        },
      });
      const user = userEvent.setup();
      renderActivity();

      const region = await agentsRegion();
      const control = await within(region).findByRole('button', {
        name: expandName(ROLE.name),
      });

      control.focus();
      await user.keyboard('{Enter}');

      expect(within(region).getByText(LONG_PROMPT)).toBeInTheDocument();
      const collapse = within(region).getByRole('button', {
        name: collapseName(ROLE.name),
      });
      expect(collapse).toHaveAttribute('aria-expanded', 'true');
      // Still the same control, so focus has not moved out from under anyone.
      expect(collapse).toHaveFocus();

      await user.click(collapse);
      expect(within(region).queryByText(LONG_PROMPT)).not.toBeInTheDocument();
      expect(
        within(region).getByRole('button', { name: expandName(ROLE.name) }),
      ).toHaveAttribute('aria-expanded', 'false');
    });

    it('names each control after its own role, and expands only that row', async () => {
      respondActivity({
        roles: { body: [ROLE, ROLE_2] },
        agents: {
          body: [
            agent({
              id: 'agent-1',
              status: 'running',
              initialPrompt: LONG_PROMPT,
            }),
            agent({
              id: 'agent-2',
              status: 'running',
              roleId: ROLE_2.id,
              initialPrompt: OTHER_LONG_PROMPT,
            }),
          ],
        },
      });
      const user = userEvent.setup();
      renderActivity();

      const region = await agentsRegion();
      const first = await within(region).findByRole('button', {
        name: expandName(ROLE.name),
      });
      // Two controls on one screen, told apart by name rather than by position
      // (WCAG 2.4.6).
      const second = within(region).getByRole('button', {
        name: expandName(ROLE_2.name),
      });

      await user.click(first);

      expect(within(region).getByText(LONG_PROMPT)).toBeInTheDocument();
      expect(
        within(region).queryByText(OTHER_LONG_PROMPT),
      ).not.toBeInTheDocument();
      expect(second).toHaveAttribute('aria-expanded', 'false');
    });

    it('keeps an expanded prompt open across a live patch to the same list', async () => {
      respondActivity({
        agents: {
          body: [
            agent({
              id: 'agent-1',
              status: 'running',
              initialPrompt: LONG_PROMPT,
            }),
          ],
        },
      });
      const user = userEvent.setup();
      const { queryClient } = renderActivity();

      const region = await agentsRegion();
      await user.click(
        await within(region).findByRole('button', {
          name: expandName(ROLE.name),
        }),
      );
      expect(within(region).getByText(LONG_PROMPT)).toBeInTheDocument();

      // The same path `cache.ts` takes for a real agent status change: the row
      // is patched in place, so the list re-renders with a new array while the
      // row's key stays put.
      act(() => {
        applyEvent(
          queryClient,
          auditEvent({ entity: 'agent', newStatus: 'paused' }, 'agent-1'),
        );
      });

      await within(region).findByText(t('activity.status.paused'));
      // Re-queried after the patch, not held from before it: the assertion is
      // that the row is still expanded, not that the old node survived.
      expect(within(region).getByText(LONG_PROMPT)).toBeInTheDocument();
      expect(
        within(region).getByRole('button', { name: collapseName(ROLE.name) }),
      ).toHaveAttribute('aria-expanded', 'true');
    });

    it('has no accessibility violations collapsed or expanded', async () => {
      respondActivity({
        agents: {
          body: [
            agent({
              id: 'agent-1',
              status: 'running',
              initialPrompt: LONG_PROMPT,
            }),
          ],
        },
      });
      const user = userEvent.setup();
      const { container } = renderActivity();

      const region = await agentsRegion();
      const control = await within(region).findByRole('button', {
        name: expandName(ROLE.name),
      });
      await expectNoA11yViolations(container);

      await user.click(control);
      await within(region).findByText(LONG_PROMPT);
      await expectNoA11yViolations(container);
    });
  });

  describe('the task status filter', () => {
    it('checks only the four active statuses by default', async () => {
      respondActivity();
      renderActivity();

      await screen.findByRole('group', { name: t('activity.filter.label') });

      for (const key of ACTIVE_FILTER_LABELS) {
        expect(screen.getByRole('checkbox', { name: t(key) })).toBeChecked();
      }
      expect(
        screen.getByRole('checkbox', { name: t('activity.status.succeeded') }),
      ).not.toBeChecked();
      expect(
        screen.getByRole('checkbox', { name: t('activity.status.failed') }),
      ).not.toBeChecked();
    });

    it('reveals a hidden status when checked, and hides it again when unchecked', async () => {
      const hidden = task({
        id: 'task-2',
        status: 'succeeded',
        shortcode: 'TASK-2',
      });
      respondActivity({ tasks: { body: [TASK_1, hidden] } });
      const user = userEvent.setup();
      renderActivity();

      await screen.findByText(TASK_1.shortcode);
      expect(screen.queryByText(hidden.shortcode)).not.toBeInTheDocument();

      const succeededCheckbox = screen.getByRole('checkbox', {
        name: t('activity.status.succeeded'),
      });

      await user.click(succeededCheckbox);
      expect(screen.getByText(hidden.shortcode)).toBeInTheDocument();

      await user.click(succeededCheckbox);
      expect(screen.queryByText(hidden.shortcode)).not.toBeInTheDocument();
    });
  });

  describe('the chats list', () => {
    it("renders each row as the control that opens that agent's chat", async () => {
      respondActivity();
      renderActivity();

      const chatsRegion = await screen.findByRole('region', {
        name: t('activity.chats.heading'),
      });
      expect(
        await within(chatsRegion).findByRole('button', {
          name: t('activity.chats.open', { role: ROLE.name }),
        }),
      ).toBeInTheDocument();
    });

    it('opens the chat dialog when a row is pressed', async () => {
      respondActivity();
      const user = userEvent.setup();
      renderActivity();

      const chatsRegion = await screen.findByRole('region', {
        name: t('activity.chats.heading'),
      });
      await user.click(
        await within(chatsRegion).findByRole('button', {
          name: t('activity.chats.open', { role: ROLE.name }),
        }),
      );

      expect(
        screen.getByRole('dialog', { name: t('chat.dialog.heading') }),
      ).toBeInTheDocument();
    });

    it('does not render, and does not count, a chat assignment with no agent', async () => {
      // The two are created together server-side, so this is not expected to
      // happen — but `ChatsList` filters it out rather than rendering a row
      // whose button could not open anything.
      const noAgent = assignment({
        id: 'chat-2',
        status: 'in-progress',
        mode: 'chat',
      });
      respondActivity({ chats: { body: [CHAT_1, noAgent] } });
      renderActivity();

      const chatsRegion = await screen.findByRole('region', {
        name: t('activity.chats.heading'),
      });
      expect(
        await within(chatsRegion).findByText(t('activity.count', { count: 1 })),
      ).toBeInTheDocument();
    });

    describe('the status and role filters', () => {
      const openChatButtons = (region: HTMLElement) =>
        within(region).getAllByRole('button', {
          name: t('activity.chats.open', { role: ROLE.name }),
        });

      it('shows only open chats by default', async () => {
        respondActivity({ chats: { body: [CHAT_1, CHAT_COMPLETED] } });
        renderActivity();

        const chatsRegion = await screen.findByRole('region', {
          name: t('activity.chats.heading'),
        });
        await within(chatsRegion).findByText(t('activity.count', { count: 1 }));
        // The count is not just a label — it agrees with what actually rendered.
        expect(openChatButtons(chatsRegion)).toHaveLength(1);
      });

      it('checking "completed" adds completed chats without hiding open ones', async () => {
        respondActivity({ chats: { body: [CHAT_1, CHAT_COMPLETED] } });
        const user = userEvent.setup();
        renderActivity();

        const chatsRegion = await screen.findByRole('region', {
          name: t('activity.chats.heading'),
        });
        await within(chatsRegion).findByText(t('activity.count', { count: 1 }));

        await user.click(
          within(chatsRegion).getByRole('checkbox', {
            name: t('activity.chats.filter.status.completed'),
          }),
        );

        await within(chatsRegion).findByText(t('activity.count', { count: 2 }));
        expect(openChatButtons(chatsRegion)).toHaveLength(2);
      });

      it('unchecking "open" as well shows chats of every status', async () => {
        respondActivity({ chats: { body: [CHAT_1, CHAT_COMPLETED] } });
        const user = userEvent.setup();
        renderActivity();

        const chatsRegion = await screen.findByRole('region', {
          name: t('activity.chats.heading'),
        });
        const openCheckbox = within(chatsRegion).getByRole('checkbox', {
          name: t('activity.chats.filter.status.open'),
        });
        expect(openCheckbox).toBeChecked();
        await within(chatsRegion).findByText(t('activity.count', { count: 1 }));

        // Both status options now unchecked — "no options selected" is
        // permissive, per the product rule, not "match nothing".
        await user.click(openCheckbox);
        expect(openCheckbox).not.toBeChecked();

        await within(chatsRegion).findByText(t('activity.count', { count: 2 }));
        expect(openChatButtons(chatsRegion)).toHaveLength(2);
      });

      it('the role filter starts empty, matching chats of every role', async () => {
        respondActivity({
          roles: { body: [ROLE, ROLE_2] },
          chats: { body: [CHAT_1, CHAT_OTHER_ROLE] },
        });
        renderActivity();

        const chatsRegion = await screen.findByRole('region', {
          name: t('activity.chats.heading'),
        });
        await within(chatsRegion).findByText(t('activity.count', { count: 2 }));
        expect(
          within(chatsRegion).getByRole('checkbox', {
            name: ROLE.name,
          }),
        ).not.toBeChecked();
      });

      it('checking one role hides chats for other roles', async () => {
        respondActivity({
          roles: { body: [ROLE, ROLE_2] },
          chats: { body: [CHAT_1, CHAT_OTHER_ROLE] },
        });
        const user = userEvent.setup();
        renderActivity();

        const chatsRegion = await screen.findByRole('region', {
          name: t('activity.chats.heading'),
        });
        await within(chatsRegion).findByText(t('activity.count', { count: 2 }));

        await user.click(
          within(chatsRegion).getByRole('checkbox', { name: ROLE.name }),
        );

        await within(chatsRegion).findByText(t('activity.count', { count: 1 }));
        expect(
          within(chatsRegion).getByRole('button', {
            name: t('activity.chats.open', { role: ROLE.name }),
          }),
        ).toBeInTheDocument();
        expect(
          within(chatsRegion).queryByRole('button', {
            name: t('activity.chats.open', { role: ROLE_2.name }),
          }),
        ).not.toBeInTheDocument();
      });

      it('checking multiple roles is a union, not an intersection', async () => {
        const role3 = {
          id: 'role-3',
          name: 'Reviewer',
          slug: 'reviewer',
          description: 'd',
        };
        const chat3 = assignment({
          id: 'chat-role-3',
          status: 'in-progress',
          mode: 'chat',
          roleId: role3.id,
          agentId: 'agent-12',
        });
        respondActivity({
          roles: { body: [ROLE, ROLE_2, role3] },
          chats: { body: [CHAT_1, CHAT_OTHER_ROLE, chat3] },
        });
        const user = userEvent.setup();
        renderActivity();

        const chatsRegion = await screen.findByRole('region', {
          name: t('activity.chats.heading'),
        });
        await within(chatsRegion).findByText(t('activity.count', { count: 3 }));

        await user.click(
          within(chatsRegion).getByRole('checkbox', { name: ROLE.name }),
        );
        await user.click(
          within(chatsRegion).getByRole('checkbox', { name: ROLE_2.name }),
        );

        // A union of the two selected roles (2 chats), not an intersection —
        // a chat has exactly one `roleId`, so an "every selected role must
        // match" reading would always find zero once more than one is picked.
        await within(chatsRegion).findByText(t('activity.count', { count: 2 }));
        expect(
          within(chatsRegion).getByRole('button', {
            name: t('activity.chats.open', { role: ROLE.name }),
          }),
        ).toBeInTheDocument();
        expect(
          within(chatsRegion).getByRole('button', {
            name: t('activity.chats.open', { role: ROLE_2.name }),
          }),
        ).toBeInTheDocument();
        expect(
          within(chatsRegion).queryByRole('button', {
            name: t('activity.chats.open', { role: role3.name }),
          }),
        ).not.toBeInTheDocument();
      });

      it('has no accessibility violations across default, permissive and narrowed filter states', async () => {
        respondActivity({
          roles: { body: [ROLE, ROLE_2] },
          chats: { body: [CHAT_1, CHAT_COMPLETED, CHAT_OTHER_ROLE] },
        });
        const user = userEvent.setup();
        const { container } = renderActivity();

        const chatsRegion = await screen.findByRole('region', {
          name: t('activity.chats.heading'),
        });
        await within(chatsRegion).findByText(t('activity.count', { count: 2 }));
        await expectNoA11yViolations(container);

        await user.click(
          within(chatsRegion).getByRole('checkbox', {
            name: t('activity.chats.filter.status.completed'),
          }),
        );
        await within(chatsRegion).findByText(t('activity.count', { count: 3 }));
        await expectNoA11yViolations(container);

        await user.click(
          within(chatsRegion).getByRole('checkbox', { name: ROLE.name }),
        );
        await within(chatsRegion).findByText(t('activity.count', { count: 2 }));
        await expectNoA11yViolations(container);
      });
    });
  });

  it('isolates a failing list from the other three', async () => {
    respondActivity({
      tasks: { status: 500, body: { statusCode: 500, message: 'boom' } },
    });
    renderActivity();

    expect(await screen.findAllByText(t('activity.error.failed'))).toHaveLength(
      1,
    );

    const tasksRegion = screen.getByRole('region', {
      name: t('activity.tasks.heading'),
    });
    expect(
      within(tasksRegion).getByText(t('activity.error.failed')),
    ).toBeInTheDocument();
    // The count is suppressed on the error path — "0 shown" would claim a
    // certainty the page does not have.
    expect(tasksRegion.querySelector('.activity-list__count')).toBeNull();

    const agentsRegion = screen.getByRole('region', {
      name: t('activity.agents.heading'),
    });
    expect(
      within(agentsRegion).getByText(AGENT_1.initialPrompt),
    ).toBeInTheDocument();

    const consultationsRegion = screen.getByRole('region', {
      name: t('activity.consultations.heading'),
    });
    expect(
      within(consultationsRegion).getByText(t('activity.count', { count: 1 })),
    ).toBeInTheDocument();

    const enquiriesRegion = screen.getByRole('region', {
      name: t('activity.enquiries.heading'),
    });
    expect(
      within(enquiriesRegion).getByText(CONVERSATION_1.question),
    ).toBeInTheDocument();
  });

  it('retries only the failing list on request', async () => {
    respondActivity({
      tasks: { status: 500, body: { statusCode: 500, message: 'boom' } },
    });
    const user = userEvent.setup();
    renderActivity();

    const tasksRegion = await screen.findByRole('region', {
      name: t('activity.tasks.heading'),
    });
    await within(tasksRegion).findByText(t('activity.error.failed'));

    const before = requestedUrls().filter((url) =>
      TASKS_ROUTE.test(url),
    ).length;

    await user.click(
      within(tasksRegion).getByRole('button', {
        name: t('state.error.retry'),
      }),
    );

    await vi.waitFor(() => {
      expect(
        requestedUrls().filter((url) => TASKS_ROUTE.test(url)).length,
      ).toBe(before + 1);
    });
  });

  it('shows each list its own empty state when every route answers with nothing', async () => {
    respondActivity(EMPTY_ROUTES);
    renderActivity();

    expect(
      await screen.findByRole('heading', {
        name: t('activity.agents.empty.heading'),
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(t('activity.agents.empty.body')),
    ).toBeInTheDocument();

    expect(
      screen.getByRole('heading', { name: t('activity.tasks.empty.heading') }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(t('activity.tasks.empty.body')),
    ).toBeInTheDocument();

    expect(
      screen.getByRole('heading', {
        name: t('activity.consultations.empty.heading'),
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(t('activity.consultations.empty.body')),
    ).toBeInTheDocument();

    expect(
      screen.getByRole('heading', {
        name: t('activity.enquiries.empty.heading'),
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(t('activity.enquiries.empty.body')),
    ).toBeInTheDocument();
  });

  it('shows the consultations caveat outside the busy region, loading, populated and empty', async () => {
    // Loading: never resolved, the assertion happens before it would be.
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    const loading = renderActivity();

    const caveatWhileLoading = screen.getByText(
      t('activity.consultations.partial'),
    );
    // ADR-023: the caveat is a standing fact about the list, not part of its
    // loading content, so it must sit outside the busy region.
    expect(caveatWhileLoading.closest('.activity-list__body')).toBeNull();
    loading.unmount();

    respondActivity();
    const populated = renderActivity();
    await screen.findByText(CONVERSATION_1.question);
    expect(
      screen.getByText(t('activity.consultations.partial')),
    ).toBeInTheDocument();
    populated.unmount();

    respondActivity(EMPTY_ROUTES);
    renderActivity();
    await screen.findByRole('heading', {
      name: t('activity.consultations.empty.heading'),
    });
    expect(
      screen.getByText(t('activity.consultations.partial')),
    ).toBeInTheDocument();
  });

  it('marks each list busy with a progress bar before any response resolves', () => {
    // Never resolved — the assertion happens before it would be.
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    renderActivity();

    const progressBars = screen.getAllByRole('progressbar');
    // Five lists now that the chats list (008.02) has joined the other four.
    expect(progressBars).toHaveLength(5);
    for (const progressBar of progressBars) {
      expect(progressBar.closest('.activity-list__body')).toHaveAttribute(
        'aria-busy',
        'true',
      );
    }
  });

  describe('announcements', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(async () => {
      await virtual.stop();
      resetAnnouncer();
      vi.useRealTimers();
    });

    it('coalesces a burst of new tasks into one phrase', async () => {
      await listen();
      respondActivity({ tasks: { body: [] } });
      const { queryClient } = renderActivity();

      const tasksRegion = await screen.findByRole('region', {
        name: t('activity.tasks.heading'),
      });
      await within(tasksRegion).findByText(t('activity.count', { count: 0 }));
      await settle();
      await virtual.clearSpokenPhraseLog();

      // None of these three tasks is cached yet, so `cache.ts` cannot patch
      // any array row and falls through to invalidating the list — the
      // fixture is swapped in before the event so the refetch answers with
      // all three at once.
      respondActivity({
        tasks: {
          body: [
            task({ id: 'task-a', status: 'ready', shortcode: 'TASK-A' }),
            task({ id: 'task-b', status: 'ready', shortcode: 'TASK-B' }),
            task({ id: 'task-c', status: 'ready', shortcode: 'TASK-C' }),
          ],
        },
      });
      act(() => {
        applyEvent(queryClient, auditEvent({ entity: 'task' }));
      });

      await within(tasksRegion).findByText(t('activity.count', { count: 3 }));
      await settle();

      expect(await virtual.spokenPhraseLog()).toEqual([
        'polite: Tasks: 3 added',
      ]);
    });

    it('announces a new enquiry immediately, not behind the list throttle window', async () => {
      await listen();
      respondActivity({ conversations: { body: [] } });
      const { queryClient } = renderActivity();

      const enquiriesRegion = await screen.findByRole('region', {
        name: t('activity.enquiries.heading'),
      });
      await within(enquiriesRegion).findByText(
        t('activity.count', { count: 0 }),
      );
      await settle();
      await virtual.clearSpokenPhraseLog();

      respondActivity({ conversations: { body: [CONVERSATION_1] } });
      act(() => {
        applyEvent(
          queryClient,
          auditEvent({
            entity: 'enquiry',
            summary: enquirySummary({
              id: CONVERSATION_1.id,
              slug: CONVERSATION_1.slug,
              status: 'awaiting_user',
              roleName: CONVERSATION_1.roleName,
              question: CONVERSATION_1.question,
            }),
          }),
        );
      });

      await within(enquiriesRegion).findByText(CONVERSATION_1.question);

      // Deliberately far shorter than the default list window
      // (`ANNOUNCE_THROTTLE_MS`, 10s): the enquiry channel uses
      // `ANNOUNCE_IMMEDIATE_MS` (0), so it must already be spoken.
      expect(ANNOUNCE_IMMEDIATE_MS).toBe(0);
      await vi.advanceTimersByTimeAsync(1);

      expect(await virtual.spokenPhraseLog()).toEqual([
        'polite: New enquiries: 1',
      ]);
    });

    it('announces nothing when the task status filter changes', async () => {
      const hidden = task({
        id: 'task-2',
        status: 'succeeded',
        shortcode: 'TASK-2',
      });
      respondActivity({ tasks: { body: [TASK_1, hidden] } });
      await listen();
      // Fake timers with no delay between key presses: user-event's own
      // internal waits would otherwise stall against the faked clock.
      const user = userEvent.setup({ delay: null });
      renderActivity();

      await screen.findByText(TASK_1.shortcode);
      await settle();
      await virtual.clearSpokenPhraseLog();

      await user.click(
        screen.getByRole('checkbox', { name: t('activity.status.succeeded') }),
      );
      await screen.findByText(hidden.shortcode);
      await settle();

      // The user narrowed a filter; the list's own hook reseeds silently
      // rather than describing their keystroke back to them. Filtered to the
      // announcer's own output (its entries carry a politeness prefix): the
      // virtual screen reader also narrates the checkbox the click focused,
      // which is expected AT behaviour and not what this assertion is about.
      const announced = (await virtual.spokenPhraseLog()).filter(
        (phrase) =>
          phrase.startsWith('polite:') || phrase.startsWith('assertive:'),
      );
      expect(announced).toEqual([]);
    });

    it('announces nothing when the chats status or role filter changes', async () => {
      respondActivity({
        roles: { body: [ROLE, ROLE_2] },
        chats: { body: [CHAT_1, CHAT_COMPLETED, CHAT_OTHER_ROLE] },
      });
      await listen();
      const user = userEvent.setup({ delay: null });
      renderActivity();

      const chatsRegion = await screen.findByRole('region', {
        name: t('activity.chats.heading'),
      });
      await within(chatsRegion).findByText(t('activity.count', { count: 2 }));
      await settle();
      await virtual.clearSpokenPhraseLog();

      // Checking "completed" brings a chat that was already there (just
      // filtered out of view) onto the screen — a filter change, not a chat
      // actually finishing, so it must not announce as one arriving. Without
      // `resetKey` reseeding `useListChangeAnnouncement`, this row entering
      // `rows` would read as an addition.
      await user.click(
        within(chatsRegion).getByRole('checkbox', {
          name: t('activity.chats.filter.status.completed'),
        }),
      );
      await within(chatsRegion).findByText(t('activity.count', { count: 3 }));
      await settle();

      // Narrowing the role filter removes a row from view the same way — it
      // must not announce as a chat ending either.
      await user.click(
        within(chatsRegion).getByRole('checkbox', { name: ROLE.name }),
      );
      await within(chatsRegion).findByText(t('activity.count', { count: 2 }));
      await settle();

      const announced = (await virtual.spokenPhraseLog()).filter(
        (phrase) =>
          phrase.startsWith('polite:') || phrase.startsWith('assertive:'),
      );
      expect(announced).toEqual([]);
    });

    it('announces nothing when the view first loads with data already present', async () => {
      await listen();
      respondActivity();
      renderActivity();

      await screen.findByText(TASK_1.shortcode);
      await settle();

      // Nine tasks already in flight on arrival is one page load, not nine
      // events — `useLoadingAnnouncement` covers the load, not this hook.
      expect(await virtual.spokenPhraseLog()).toEqual([]);
    });
  });

  it('has no accessibility violations, populated or empty', async () => {
    respondActivity();
    const populated = renderActivity();
    await screen.findByText(CONVERSATION_1.question);
    await expectNoA11yViolations(populated.container);
    populated.unmount();

    respondActivity(EMPTY_ROUTES);
    const empty = renderActivity();
    await screen.findByRole('heading', {
      name: t('activity.agents.empty.heading'),
    });
    await expectNoA11yViolations(empty.container);
  });
});
