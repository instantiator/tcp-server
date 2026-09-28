import { virtual } from '@guidepup/virtual-screen-reader';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuditWireEvent, WireEvent } from '@tcp/shared/client';
import { StrictMode } from 'react';
import { Button } from 'react-aria-components';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { statusLabel } from '../../api/statuses';
import { streamUrls, subscribe } from '../../events/subscriptions';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import {
  fetchMock,
  installFetchMock,
  respondByRoute,
  type RouteResponse,
} from '../../test-support/fetch-mock';
import { DockProvider } from '../Dialog/DockProvider';
import { ChatProvider } from './ChatProvider';
import { useChat } from './useChat';

// Mocked the way `Transcript.test.tsx` mocks it, but keyed by **url** rather
// than held as one pair of module-level variables — this file opens two
// agents' streams at once, and a single `emit`/`fail` pair would let a test
// silently emit on the wrong one.
vi.mock('../../events/subscriptions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../events/subscriptions')>()),
  subscribe: vi.fn(),
}));

const subscribeMock = vi.mocked(subscribe);

const COMPANY_ID = 'company-1';
const NOW = '2026-08-10T09:00:00.000Z';

const AGENT_A = 'agent-a';
const ROLE_A = 'Sales';
const AGENT_B = 'agent-b';
const ROLE_B = 'Legal';

/** This conversation's stream handle, as the real `subscribe` hands to a caller. */
interface StreamHandle {
  readonly emit: (event: WireEvent) => void;
  readonly fail: (error: Error) => void;
}

// The current handle for each open url, and a running tally of subscribe
// calls minus unsubscribe calls for that url — a stand-in for
// `openStreamCount` from `subscriptions.ts`, which this mock replaces
// entirely. Built in now rather than bolted on later: it is what proves a
// panel opens exactly one connection for its agent, never two.
const handles = new Map<string, StreamHandle>();
const openCounts = new Map<string, number>();

/** The captured handle for one agent's event stream. Fails loudly if absent. */
const streamFor = (agentId: string): StreamHandle => {
  const handle = handles.get(streamUrls.agent(agentId));
  if (handle === undefined) {
    throw new Error(`no subscription is open for ${agentId}`);
  }
  return handle;
};

const agentFixture = (id: string, status: string) => ({
  id,
  companyId: COMPANY_ID,
  roleId: 'role-1',
  assignmentId: 'assignment-1',
  status,
  threadId: null,
  initialPrompt: `${id} initial prompt`,
  createdAt: NOW,
  output: null,
  updatedAt: NOW,
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

/** A live `state_change` audit event, as `MessageInput` reads the agent's status from. */
const stateChangeEvent = (agentId: string, newStatus: string): WireEvent => ({
  type: 'audit',
  event: {
    id: `state-${agentId}-${newStatus}`,
    timestamp: NOW,
    companyId: COMPANY_ID,
    role: 'system',
    agentId,
    assignmentId: null,
    taskId: null,
    eventType: 'state_change',
    payload: { entity: 'agent', newStatus },
  },
});

const HISTORY_A_ROUTE = /\/api\/agent\/agent-a\/history/;
const HISTORY_B_ROUTE = /\/api\/agent\/agent-b\/history/;
const MESSAGE_A_ROUTE = /\/api\/agent\/agent-a\/message/;
const MESSAGE_B_ROUTE = /\/api\/agent\/agent-b\/message/;
const COMPLETE_A_ROUTE = /\/api\/agent\/agent-a\/complete/;
const COMPLETE_B_ROUTE = /\/api\/agent\/agent-b\/complete/;
// Anchored so neither collides with the `/history`, `/message` or `/complete`
// routes above — they all share the `/api/agent/agent-a` prefix.
const AGENT_A_ROUTE = /\/api\/agent\/agent-a(\?|$)/;
const AGENT_B_ROUTE = /\/api\/agent\/agent-b(\?|$)/;

interface ChatRoutes {
  readonly historyA?: RouteResponse;
  readonly historyB?: RouteResponse;
  readonly agentA?: RouteResponse;
  readonly agentB?: RouteResponse;
  readonly messageA?: RouteResponse;
  readonly messageB?: RouteResponse;
  readonly completeA?: RouteResponse;
  readonly completeB?: RouteResponse;
}

/**
 * Answers every route a mounted conversation can reach: its history, its
 * agent detail (`MessageInput` and the dock label both read this), and its
 * message endpoint. Each history defaults to one row rather than none, so a
 * freshly opened panel's transcript renders as an `<ol>` — `Transcript`
 * shows an empty-state heading instead when there is nothing to show, and
 * several assertions below need the real list role.
 */
const respondChat = (
  overrides: ChatRoutes = {},
  extra: readonly (readonly [RegExp, RouteResponse])[] = [],
): void => {
  respondByRoute([
    ...extra,
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
    [MESSAGE_A_ROUTE, overrides.messageA ?? { status: 202, body: undefined }],
    [MESSAGE_B_ROUTE, overrides.messageB ?? { status: 202, body: undefined }],
    // The completed agent, as the route answers with — the panel reads its own
    // status from the event stream, not from this, so the body only has to be
    // an agent.
    [
      COMPLETE_A_ROUTE,
      overrides.completeA ?? { body: agentFixture(AGENT_A, 'completed') },
    ],
    [
      COMPLETE_B_ROUTE,
      overrides.completeB ?? { body: agentFixture(AGENT_B, 'completed') },
    ],
    [
      AGENT_A_ROUTE,
      overrides.agentA ?? { body: agentFixture(AGENT_A, 'idle') },
    ],
    [
      AGENT_B_ROUTE,
      overrides.agentB ?? { body: agentFixture(AGENT_B, 'idle') },
    ],
  ]);
};

const OPEN_A = { agentId: AGENT_A, roleName: ROLE_A, reference: null };
const OPEN_B = { agentId: AGENT_B, roleName: ROLE_B, reference: null };
const OPEN_A_WITH_REFERENCE = {
  agentId: AGENT_A,
  roleName: ROLE_A,
  reference: 'CHAT-1',
};

/**
 * A real, keyboard-reachable control per conversation — so React Aria's
 * dialog has something to return focus to on close, and StrictMode's double
 * effect invocation is exercised the same way a real page would trigger it.
 * `useChat()` throws outside a `ChatProvider`, which is exactly the contract
 * this component exists to exercise.
 */
const Opener = () => {
  const { openChat } = useChat();
  return (
    <>
      <Button
        className="react-aria-Button"
        onPress={() => {
          openChat(OPEN_A);
        }}
      >
        Open Sales
      </Button>
      <Button
        className="react-aria-Button"
        onPress={() => {
          openChat(OPEN_B);
        }}
      >
        Open Legal
      </Button>
      <Button
        className="react-aria-Button"
        onPress={() => {
          openChat(OPEN_A_WITH_REFERENCE);
        }}
      >
        Open Sales (CHAT-1)
      </Button>
      <Button
        className="react-aria-Button"
        onPress={() => {
          openChat({ ...OPEN_A, readOnly: true });
        }}
      >
        Listen in to Sales
      </Button>
    </>
  );
};

/**
 * `path` is the route the dialog opens over. The dialog's "Add new" menu shows
 * only on a company route, so the default `/` keeps it out of every test that
 * isn't about it.
 */
const renderChat = (path = '/') => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    queryClient,
    ...render(
      <StrictMode>
        <MemoryRouter initialEntries={[path]}>
          <QueryClientProvider client={queryClient}>
            <DockProvider>
              <ChatProvider>
                <Opener />
              </ChatProvider>
            </DockProvider>
          </QueryClientProvider>
        </MemoryRouter>
      </StrictMode>,
    ),
  };
};

/** Every open transcript has resolved its history and stopped showing its progressbar. */
const waitForTranscriptsReady = () =>
  waitFor(() => {
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
  });

const dockLabel = (role: string, status: string) =>
  t('chat.dock.label', { role, status: statusLabel(status) });

/**
 * Gets both conversations into one open dialog, the way a user actually can.
 *
 * Pressing "Open Legal" while the Sales panel is showing does not work:
 * React Aria's `Modal` marks everything behind it `aria-hidden` while it is
 * open, so a second "open chat" control — which in the real app lives on the
 * page behind the dialog, in `ChatsList` — is correctly unreachable. The real
 * route to two panels is `ChatProvider`'s own: minimising Sales parks it
 * without clearing it from `conversations`, and opening Legal afterwards
 * un-parks everything docked and adds Legal alongside it, landing both in the
 * dialog that reopens.
 */
const openTwoConversations = async (
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> => {
  await user.click(screen.getByRole('button', { name: 'Open Sales' }));
  await waitForTranscriptsReady();
  await user.click(screen.getByRole('button', { name: t('dialog.minimise') }));
  await user.click(screen.getByRole('button', { name: 'Open Legal' }));
  await waitForTranscriptsReady();
};

describe('ChatDialog', () => {
  beforeEach(() => {
    installFetchMock();
    handles.clear();
    openCounts.clear();

    subscribeMock.mockImplementation((url, onEvent, onError) => {
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

  it('renders nothing until a conversation is opened', () => {
    respondChat();
    renderChat();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      screen.queryByRole('navigation', { name: t('dock.label') }),
    ).toBeNull();
  });

  it('shows two open conversations as two labelled panels, each with its own transcript', async () => {
    respondChat();
    const user = userEvent.setup();
    renderChat();

    await openTwoConversations(user);

    const panelA = screen.getByRole('region', {
      name: t('chat.conversation.label', { role: ROLE_A }),
    });
    const panelB = screen.getByRole('region', {
      name: t('chat.conversation.label', { role: ROLE_B }),
    });
    expect(
      within(panelA).getByRole('list', {
        name: t('transcript.label', { role: ROLE_A }),
      }),
    ).toBeTruthy();
    expect(
      within(panelB).getByRole('list', {
        name: t('transcript.label', { role: ROLE_B }),
      }),
    ).toBeTruthy();

    // One connection per agent, not two — the fan-out `MAX_STREAMS` exists to
    // catch, made concrete here rather than only guarded against.
    expect(openCounts.get(streamUrls.agent(AGENT_A))).toBe(1);
    expect(openCounts.get(streamUrls.agent(AGENT_B))).toBe(1);
  });

  it('names a conversation by its reference when it has one', async () => {
    respondChat();
    const user = userEvent.setup();
    renderChat();

    await user.click(
      screen.getByRole('button', { name: 'Open Sales (CHAT-1)' }),
    );
    await waitForTranscriptsReady();

    expect(
      screen.getByRole('region', {
        name: t('chat.conversation.labelWithReference', {
          role: ROLE_A,
          reference: 'CHAT-1',
        }),
      }),
    ).toBeTruthy();
  });

  describe('listening in', () => {
    it('shows the live transcript with nothing to send and nothing to complete', async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      await user.click(
        screen.getByRole('button', { name: 'Listen in to Sales' }),
      );
      await waitForTranscriptsReady();

      const panel = screen.getByRole('region', {
        name: t('chat.conversation.listening', { role: ROLE_A }),
      });
      expect(
        within(panel).getByRole('list', {
          name: t('transcript.label', { role: ROLE_A }),
        }),
      ).toBeTruthy();
      expect(within(panel).queryByRole('textbox')).toBeNull();
      expect(
        within(panel).queryByRole('button', {
          name: t('chat.complete', { role: ROLE_A }),
        }),
      ).toBeNull();
    });

    it('never takes the message field away from a chat already open', async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      await user.click(screen.getByRole('button', { name: 'Open Sales' }));
      await waitForTranscriptsReady();
      await user.click(
        screen.getByRole('button', { name: t('dialog.minimise') }),
      );
      await user.click(
        screen.getByRole('button', { name: 'Listen in to Sales' }),
      );
      await waitForTranscriptsReady();

      const panel = screen.getByRole('region', {
        name: t('chat.conversation.label', { role: ROLE_A }),
      });
      expect(within(panel).getByRole('textbox')).toBeTruthy();
    });

    it('has no accessibility violations', async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      await user.click(
        screen.getByRole('button', { name: 'Listen in to Sales' }),
      );
      await waitForTranscriptsReady();

      await expectNoA11yViolations(document.body);
    });
  });

  // Asserted as an absence, deliberately. The dialog's own close button used
  // to do exactly what minimise does, so its removal is the fix rather than a
  // tidy-up, and an absence nobody asserts is one a future edit restores by
  // accident.
  //
  // CHANGED (002.02 stage 7): renamed from "has no close control of its own —
  // only minimise" to say "dialog chrome" — a per-panel Close button now
  // exists (`ChatConversation`), so the old title read as false. The
  // assertions are unchanged: `t('dialog.close')` is still the framework's
  // own chrome control (`Dialog.tsx`'s `hideClose`), not any panel's Close.
  it('has no dialog-chrome close control of its own — only minimise', async () => {
    respondChat();
    const user = userEvent.setup();
    renderChat();

    await user.click(screen.getByRole('button', { name: 'Open Sales' }));
    await waitForTranscriptsReady();

    expect(
      screen.queryByRole('button', { name: t('dialog.close') }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: t('dialog.minimise') }),
    ).toBeTruthy();
  });

  it('parks every open conversation when minimised', async () => {
    respondChat();
    const user = userEvent.setup();
    renderChat();

    await openTwoConversations(user);

    await user.click(
      screen.getByRole('button', { name: t('dialog.minimise') }),
    );

    expect(screen.queryByRole('dialog')).toBeNull();
    const dock = screen.getByRole('navigation', { name: t('dock.label') });
    expect(within(dock).getAllByRole('button')).toHaveLength(2);
  });

  // Verified rather than assumed: `MessageInput` holds its typed value in its
  // own `useState`, and minimising unmounts every panel (`Dialog.tsx` — a
  // parked modal is gone, not hidden). So a draft cannot survive the round
  // trip, and this asserts that truth rather than the more comfortable one.
  it('minimises on escape without discarding the open conversations, though an unsent draft is not preserved', async () => {
    respondChat();
    const user = userEvent.setup();
    renderChat();

    await openTwoConversations(user);

    const fieldA = screen.getByRole('textbox', {
      name: t('chat.message.label', { role: ROLE_A }),
    });
    await user.type(fieldA, 'Draft message');
    expect(fieldA).toHaveValue('Draft message');

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(
      screen.getByRole('button', { name: dockLabel(ROLE_A, 'idle') }),
    );

    expect(
      screen.getByRole('dialog', { name: t('chat.dialog.heading') }),
    ).toBeTruthy();
    expect(
      screen.getByRole('region', {
        name: t('chat.conversation.label', { role: ROLE_A }),
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole('region', {
        name: t('chat.conversation.label', { role: ROLE_B }),
      }),
    ).toBeTruthy();

    await waitForTranscriptsReady();
    const restoredFieldA = screen.getByRole('textbox', {
      name: t('chat.message.label', { role: ROLE_A }),
    });
    expect(restoredFieldA).toHaveValue('');
  });

  it("names a dock button by the agent's role and status", async () => {
    respondChat();
    const user = userEvent.setup();
    renderChat();

    await user.click(screen.getByRole('button', { name: 'Open Sales' }));
    await waitForTranscriptsReady();

    await user.click(
      screen.getByRole('button', { name: t('dialog.minimise') }),
    );

    expect(
      screen.getByRole('button', { name: dockLabel(ROLE_A, 'idle') }),
    ).toBeTruthy();
  });

  it('restores every conversation, not only the one whose button was pressed', async () => {
    respondChat();
    const user = userEvent.setup();
    renderChat();

    await openTwoConversations(user);

    await user.click(
      screen.getByRole('button', { name: t('dialog.minimise') }),
    );

    await user.click(
      screen.getByRole('button', { name: dockLabel(ROLE_B, 'idle') }),
    );

    expect(
      screen.getByRole('region', {
        name: t('chat.conversation.label', { role: ROLE_A }),
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole('region', {
        name: t('chat.conversation.label', { role: ROLE_B }),
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('navigation', { name: t('dock.label') }),
    ).toBeNull();
  });

  it('keeps each conversation state separate: a delta on one stream never reaches the other', async () => {
    respondChat();
    const user = userEvent.setup();
    renderChat();

    await openTwoConversations(user);

    act(() => {
      streamFor(AGENT_A).emit({
        type: 'stream',
        agentId: AGENT_A,
        channel: 'response',
        delta: 'Only for Sales',
        timestamp: NOW,
      });
    });

    const panelA = screen.getByRole('region', {
      name: t('chat.conversation.label', { role: ROLE_A }),
    });
    const panelB = screen.getByRole('region', {
      name: t('chat.conversation.label', { role: ROLE_B }),
    });
    expect(within(panelA).getByText(/Only for Sales/)).toBeInTheDocument();
    expect(within(panelB).queryByText(/Only for Sales/)).toBeNull();
  });

  it("sends a typed message as a POST to that agent's own endpoint", async () => {
    respondChat();
    const user = userEvent.setup();
    renderChat();

    await user.click(screen.getByRole('button', { name: 'Open Sales' }));
    await waitForTranscriptsReady();

    await user.type(
      screen.getByRole('textbox', {
        name: t('chat.message.label', { role: ROLE_A }),
      }),
      'Hello there',
    );
    await user.click(screen.getByRole('button', { name: t('chat.send') }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input]) =>
            input instanceof Request && MESSAGE_A_ROUTE.test(input.url),
        ),
      ).toBe(true);
    });

    const call = fetchMock.mock.calls.find(
      ([input]) => input instanceof Request && MESSAGE_A_ROUTE.test(input.url),
    );
    const request = call?.[0];
    if (!(request instanceof Request)) {
      throw new Error('no POST to /api/agent/agent-a/message was made');
    }
    const body: unknown = await request.clone().json();
    expect(body).toEqual({ message: 'Hello there' });
  });

  it("shows the waiting line and disables only the busy agent's field while a turn runs", async () => {
    respondChat();
    const user = userEvent.setup();
    renderChat();

    await openTwoConversations(user);

    const fieldA = screen.getByRole('textbox', {
      name: t('chat.message.label', { role: ROLE_A }),
    });
    const fieldB = screen.getByRole('textbox', {
      name: t('chat.message.label', { role: ROLE_B }),
    });
    const panelA = screen.getByRole('region', {
      name: t('chat.conversation.label', { role: ROLE_A }),
    });

    await user.type(fieldA, 'Hi');
    await user.click(
      within(panelA).getByRole('button', { name: t('chat.send') }),
    );
    await waitFor(() => {
      expect(fieldA).toHaveValue('');
    });

    // Waiting comes from the agent's own status arriving on its stream, not
    // from the mutation's pending state — which has already settled by now.
    // The cache patch itself is synchronous, but TanStack Query's
    // `notifyManager` batches the observer notification through a microtask,
    // so the re-render lands a tick after `act()` returns — `waitFor` rather
    // than an immediate assertion, unlike `Transcript`'s own local state.
    act(() => {
      streamFor(AGENT_A).emit(stateChangeEvent(AGENT_A, 'running'));
    });

    await waitFor(() => {
      expect(
        screen.getByText(t('chat.waiting', { role: ROLE_A })),
      ).toBeInTheDocument();
    });
    expect(fieldA).toBeDisabled();
    expect(fieldB).not.toBeDisabled();

    act(() => {
      streamFor(AGENT_A).emit(stateChangeEvent(AGENT_A, 'idle'));
    });

    await waitFor(() => {
      expect(
        screen.queryByText(t('chat.waiting', { role: ROLE_A })),
      ).toBeNull();
    });
    expect(fieldA).not.toBeDisabled();
  });

  it('keeps the typed text when a send fails', async () => {
    respondChat({
      messageA: { status: 500, body: { statusCode: 500, message: 'boom' } },
    });
    const user = userEvent.setup();
    renderChat();

    await user.click(screen.getByRole('button', { name: 'Open Sales' }));
    await waitForTranscriptsReady();

    const fieldA = screen.getByRole('textbox', {
      name: t('chat.message.label', { role: ROLE_A }),
    });
    await user.type(fieldA, 'Will fail');
    await user.click(screen.getByRole('button', { name: t('chat.send') }));

    expect(await screen.findByText(t('chat.send.failed'))).toBeInTheDocument();
    expect(fieldA).toHaveValue('Will fail');
  });

  it('does nothing when the field is empty', async () => {
    respondChat();
    const user = userEvent.setup();
    renderChat();

    await user.click(screen.getByRole('button', { name: 'Open Sales' }));
    await waitForTranscriptsReady();

    await user.click(screen.getByRole('button', { name: t('chat.send') }));

    expect(
      fetchMock.mock.calls.some(
        ([input]) =>
          input instanceof Request && MESSAGE_A_ROUTE.test(input.url),
      ),
    ).toBe(false);
  });

  it('has no accessibility violations with two conversations open', async () => {
    respondChat();
    const user = userEvent.setup();
    renderChat();

    await openTwoConversations(user);

    // React Aria's `Modal` portals out of the render container, so the scan
    // has to cover `document.body` — same reasoning as `DockProvider.test.tsx`.
    await expectNoA11yViolations(document.body);
  });

  it('has no accessibility violations with two conversations parked', async () => {
    respondChat();
    const user = userEvent.setup();
    renderChat();

    await openTwoConversations(user);
    await user.click(
      screen.getByRole('button', { name: t('dialog.minimise') }),
    );

    // The parked state is a state of this feature, not an absence of one: two
    // buttons in a landmark, each naming a conversation the user still has.
    await expectNoA11yViolations(document.body);
  });

  /**
   * Completing a chat, which ends the conversation without ending the panel.
   *
   * The distinction is the whole feature: the transcript is a record worth
   * keeping, so the panel stays and only the form goes. Everything below is an
   * assertion that the panel survived, as much as that the chat ended.
   */
  describe('completing a chat', () => {
    const completeButton = (role: string) =>
      screen.getByRole('button', { name: t('chat.complete', { role }) });

    const panelFor = (role: string) =>
      screen.getByRole('region', {
        name: t('chat.conversation.label', { role }),
      });

    /** Opens Sales, presses Complete, and lets the agent's status catch up. */
    const completeSales = async (
      user: ReturnType<typeof userEvent.setup>,
    ): Promise<void> => {
      await user.click(screen.getByRole('button', { name: 'Open Sales' }));
      await waitForTranscriptsReady();
      await user.click(completeButton(ROLE_A));
      // The panel learns it is over from the agent's own stream, exactly as it
      // would from a completion someone else made — not from the mutation's
      // response, which nothing here reads.
      act(() => {
        streamFor(AGENT_A).emit(stateChangeEvent(AGENT_A, 'completed'));
      });
    };

    it("posts to that agent's own complete endpoint", async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      await completeSales(user);

      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some(
            ([input]) =>
              input instanceof Request && COMPLETE_A_ROUTE.test(input.url),
          ),
        ).toBe(true);
      });
      expect(
        fetchMock.mock.calls.some(
          ([input]) =>
            input instanceof Request && COMPLETE_B_ROUTE.test(input.url),
        ),
      ).toBe(false);
    });

    it('keeps the panel and its transcript, and takes the form away', async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      await completeSales(user);

      await waitFor(() => {
        expect(screen.getByText(t('chat.done'))).toBeInTheDocument();
      });
      const panel = panelFor(ROLE_A);
      expect(
        within(panel).getByRole('list', {
          name: t('transcript.label', { role: ROLE_A }),
        }),
      ).toBeTruthy();
      expect(
        within(panel).queryByRole('textbox', {
          name: t('chat.message.label', { role: ROLE_A }),
        }),
      ).toBeNull();
      expect(
        within(panel).queryByRole('button', { name: t('chat.send') }),
      ).toBeNull();
    });

    it('hides its own button once the chat is over', async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      await completeSales(user);

      await waitFor(() => {
        expect(
          screen.queryByRole('button', {
            name: t('chat.complete', { role: ROLE_A }),
          }),
        ).toBeNull();
      });
    });

    // Not only when this button ended it: an agent that failed mid-turn is
    // just as over, and offering to complete it would be offering nothing.
    it('hides its own button when the agent fails on its own', async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      await user.click(screen.getByRole('button', { name: 'Open Sales' }));
      await waitForTranscriptsReady();

      act(() => {
        streamFor(AGENT_A).emit(stateChangeEvent(AGENT_A, 'failed'));
      });

      await waitFor(() => {
        expect(
          screen.queryByRole('button', {
            name: t('chat.complete', { role: ROLE_A }),
          }),
        ).toBeNull();
      });
      expect(screen.getByText(t('chat.done'))).toBeInTheDocument();
    });

    it('cannot be completed while a turn is in flight', async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      await user.click(screen.getByRole('button', { name: 'Open Sales' }));
      await waitForTranscriptsReady();

      act(() => {
        streamFor(AGENT_A).emit(stateChangeEvent(AGENT_A, 'running'));
      });

      await waitFor(() => {
        expect(completeButton(ROLE_A)).toBeDisabled();
      });
      await user.click(completeButton(ROLE_A));
      expect(
        fetchMock.mock.calls.some(
          ([input]) =>
            input instanceof Request && COMPLETE_A_ROUTE.test(input.url),
        ),
      ).toBe(false);
    });

    it('completes only the conversation whose button was pressed', async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      await openTwoConversations(user);
      await user.click(completeButton(ROLE_A));
      act(() => {
        streamFor(AGENT_A).emit(stateChangeEvent(AGENT_A, 'completed'));
      });

      await waitFor(() => {
        expect(screen.getByText(t('chat.done'))).toBeInTheDocument();
      });
      // Legal is untouched: still a form, still a button of its own.
      expect(
        within(panelFor(ROLE_B)).getByRole('textbox', {
          name: t('chat.message.label', { role: ROLE_B }),
        }),
      ).toBeTruthy();
      expect(completeButton(ROLE_B)).toBeTruthy();
    });

    it('shows the failure and leaves the chat usable when completing fails', async () => {
      respondChat({
        completeA: { status: 409, body: { statusCode: 409, message: 'busy' } },
      });
      const user = userEvent.setup();
      renderChat();

      await user.click(screen.getByRole('button', { name: 'Open Sales' }));
      await waitForTranscriptsReady();
      await user.click(completeButton(ROLE_A));

      expect(
        await screen.findByText(t('chat.complete.failed')),
      ).toBeInTheDocument();
      // Nothing about the panel changed: the chat is not over, so the form and
      // the button both have to still be there to try again with.
      expect(
        screen.getByRole('textbox', {
          name: t('chat.message.label', { role: ROLE_A }),
        }),
      ).not.toBeDisabled();
      expect(completeButton(ROLE_A)).toBeTruthy();
    });

    it('has no accessibility violations with one conversation completed', async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      await openTwoConversations(user);
      await user.click(completeButton(ROLE_A));
      act(() => {
        streamFor(AGENT_A).emit(stateChangeEvent(AGENT_A, 'completed'));
      });
      await waitFor(() => {
        expect(screen.getByText(t('chat.done'))).toBeInTheDocument();
      });

      // A completed panel beside a live one is a state of this feature, and
      // the one most likely to go wrong: a heading with nothing focusable
      // under it, next to a form that still works.
      await expectNoA11yViolations(document.body);
    });
  });

  /**
   * Closing a chat (002.02 stage 7): the fix for chats piling up in the dock
   * with no way to drop them. Unlike Complete, Close removes the panel
   * itself — but the chat stays open on the server, and `ChatsList` (Activity
   * → Chats) is how it is found again, so nothing here talks to the network.
   */
  describe('closing a chat', () => {
    const closeButton = (role: string) =>
      screen.getByRole('button', { name: t('chat.close', { role }) });

    const panelFor = (role: string) =>
      screen.queryByRole('region', {
        name: t('chat.conversation.label', { role }),
      });

    it('removes only the panel that was closed', async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      await openTwoConversations(user);
      await user.click(closeButton(ROLE_A));

      expect(panelFor(ROLE_A)).toBeNull();
      expect(panelFor(ROLE_B)).toBeTruthy();
    });

    it('closes the dialog once its last panel is closed', async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      await user.click(screen.getByRole('button', { name: 'Open Sales' }));
      await waitForTranscriptsReady();
      await user.click(closeButton(ROLE_A));

      expect(screen.queryByRole('dialog')).toBeNull();
    });

    // The dock has no reachable path to a panel that is also open (opening
    // any docked conversation un-parks every docked one — see
    // `openTwoConversations`), so this exercises the defensive cleanup in
    // `ChatProvider.closeChat` rather than a state the UI can otherwise
    // reach: the bar must not come back empty-handed just because a
    // conversation that used to be docked was later closed.
    it('removes its dock entry, if it had one, once restored and closed', async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      await openTwoConversations(user);
      await user.click(
        screen.getByRole('button', { name: t('dialog.minimise') }),
      );
      await user.click(
        screen.getByRole('button', { name: dockLabel(ROLE_B, 'idle') }),
      );
      await waitForTranscriptsReady();

      await user.click(closeButton(ROLE_A));

      expect(
        screen.queryByRole('navigation', { name: t('dock.label') }),
      ).toBeNull();
    });

    it("releases the closed panel's stream, leaving the other open", async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      await openTwoConversations(user);
      await user.click(closeButton(ROLE_A));

      expect(openCounts.get(streamUrls.agent(AGENT_A))).toBe(0);
      expect(openCounts.get(streamUrls.agent(AGENT_B))).toBe(1);
    });

    it('is on a read-only listening-in panel too', async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      await user.click(
        screen.getByRole('button', { name: 'Listen in to Sales' }),
      );
      await waitForTranscriptsReady();

      await user.click(closeButton(ROLE_A));

      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('stays available after the chat completes', async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      await user.click(screen.getByRole('button', { name: 'Open Sales' }));
      await waitForTranscriptsReady();
      act(() => {
        streamFor(AGENT_A).emit(stateChangeEvent(AGENT_A, 'completed'));
      });

      await waitFor(() => {
        expect(screen.getByText(t('chat.done'))).toBeInTheDocument();
      });
      expect(closeButton(ROLE_A)).toBeTruthy();
    });

    it("names each panel's Close button by its own role", async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      await openTwoConversations(user);

      expect(
        within(panelFor(ROLE_A) as HTMLElement).getByRole('button', {
          name: t('chat.close', { role: ROLE_A }),
        }),
      ).toBeTruthy();
      expect(
        within(panelFor(ROLE_B) as HTMLElement).getByRole('button', {
          name: t('chat.close', { role: ROLE_B }),
        }),
      ).toBeTruthy();
    });

    it('has no accessibility violations with two panels, each with its close control', async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      await openTwoConversations(user);
      // Two Close buttons, so the scan covers the pair (distinct names, no
      // duplicate-id or nesting problem between panels), not just one.
      expect(closeButton(ROLE_A)).toBeTruthy();
      expect(closeButton(ROLE_B)).toBeTruthy();

      await expectNoA11yViolations(document.body);
    });
  });

  /**
   * Where focus goes, which for this dialog is several separate decisions.
   *
   * ADR-027 manages focus at four points, and four of them happen here: the
   * dialog opening, the dialog being taken off the page, a focused control
   * disappearing — which is what completing a chat does to its own button —
   * and closing a panel, which is the newest of the four (002.02 stage 7).
   * None of them may leave focus on `document.body`, which is where it
   * silently lands whenever a focused element is removed and nobody says where
   * it should go instead.
   */
  describe('focus', () => {
    const panelFor = (role: string) =>
      screen.getByRole('region', {
        name: t('chat.conversation.label', { role }),
      });

    it('lands on the dock button when the dialog is minimised', async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      await user.click(screen.getByRole('button', { name: 'Open Sales' }));
      await waitForTranscriptsReady();
      await user.click(
        screen.getByRole('button', { name: t('dialog.minimise') }),
      );

      // `waitFor`, because this is a race the dock deliberately wins rather
      // than one it happens to: React Aria returns focus to whatever opened
      // the dialog when the overlay unmounts, and `DockProvider` schedules its
      // own focus a turn later so it is the last word.
      await waitFor(() => {
        expect(document.activeElement).toBe(
          screen.getByRole('button', { name: dockLabel(ROLE_A, 'idle') }),
        );
      });
    });

    it('lands in the restored conversation when a dock button is pressed', async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      await openTwoConversations(user);
      await user.click(
        screen.getByRole('button', { name: t('dialog.minimise') }),
      );
      await user.click(
        screen.getByRole('button', { name: dockLabel(ROLE_B, 'idle') }),
      );
      await waitForTranscriptsReady();

      // The conversation whose button was pressed, not the first one back on
      // screen. Both are restored; only one was asked for.
      await waitFor(() => {
        expect(document.activeElement).toBe(panelFor(ROLE_B));
      });
    });

    it('lands on the panel when its complete button disappears', async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      await openTwoConversations(user);
      await user.click(
        screen.getByRole('button', {
          name: t('chat.complete', { role: ROLE_A }),
        }),
      );
      // The press left focus on the button; the terminal status removes it.
      act(() => {
        streamFor(AGENT_A).emit(stateChangeEvent(AGENT_A, 'completed'));
      });

      // Its own panel, not a neighbour: nothing was destroyed, and the
      // conversation the user was working in is still on screen to be read.
      await waitFor(() => {
        expect(document.activeElement).toBe(panelFor(ROLE_A));
      });
      expect(document.activeElement).not.toBe(document.body);
    });

    const closeButton = (role: string) =>
      screen.getByRole('button', { name: t('chat.close', { role }) });

    it('moves focus to the following panel when it is closed', async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      await openTwoConversations(user);
      await user.click(closeButton(ROLE_A));

      // Sales was first; Legal took its place. The panel that follows, not a
      // fixed "first remaining panel" — `openTwoConversations` happens to
      // leave Legal there either way, but `closeChat` computes this from the
      // closed panel's own index, not from being "whatever's left".
      await waitFor(() => {
        expect(document.activeElement).toBe(panelFor(ROLE_B));
      });
    });

    it('moves focus to the previous panel when the last one is closed', async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      await openTwoConversations(user);
      await user.click(closeButton(ROLE_B));

      await waitFor(() => {
        expect(document.activeElement).toBe(panelFor(ROLE_A));
      });
    });

    it('returns focus to the trigger once the last panel closes', async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      const opener = screen.getByRole('button', { name: 'Open Sales' });
      await user.click(opener);
      await waitForTranscriptsReady();
      await user.click(closeButton(ROLE_A));

      expect(screen.queryByRole('dialog')).toBeNull();
      // React Aria's `Modal` returns focus to whatever opened it once the
      // overlay unmounts — the same mechanism a plain `Escape` relies on,
      // exercised here by the dialog closing itself once its last panel goes.
      await waitFor(() => {
        expect(document.activeElement).toBe(opener);
      });
    });
  });

  /**
   * What a screen reader hears, which for a streaming surface is mostly
   * "nothing".
   *
   * This dialog is the surface ADR-027's never-announce-a-partial-response
   * rule was written for: it is the only place in the application where two
   * responses can stream at once. `useTranscript` already proves the rule for
   * one transcript; what is proved here is that two of them are two separate
   * voices rather than one description of neither.
   */
  describe('speech', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(async () => {
      await virtual.stop();
      vi.useRealTimers();
    });

    const delta = (agentId: string, text: string): WireEvent => ({
      type: 'stream',
      agentId,
      channel: 'response',
      delta: text,
      timestamp: NOW,
    });

    const completion = (agentId: string, id: string): WireEvent => ({
      type: 'audit',
      event: auditEvent(agentId, {
        id,
        eventType: 'llm_response',
        payload: { responseText: 'done' },
      }),
    });

    it('says nothing while two responses stream at once', async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();
      await openTwoConversations(user);

      await virtual.start({ container: document.body });
      await virtual.clearSpokenPhraseLog();

      for (const token of 'one token at a time'.split(' ')) {
        act(() => {
          streamFor(AGENT_A).emit(delta(AGENT_A, `${token} `));
          streamFor(AGENT_B).emit(delta(AGENT_B, `${token} `));
        });
      }
      // Well past the announcer's throttle, so anything coalescing would have
      // been spoken by now.
      await vi.advanceTimersByTimeAsync(15_000);

      expect(await virtual.spokenPhraseLog()).toEqual([]);
    });

    it('announces each completed response once, naming its own role', async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();
      await openTwoConversations(user);

      await virtual.start({ container: document.body });
      await virtual.clearSpokenPhraseLog();

      act(() => {
        streamFor(AGENT_A).emit(completion(AGENT_A, 'response-a'));
        streamFor(AGENT_B).emit(completion(AGENT_B, 'response-b'));
      });
      await vi.advanceTimersByTimeAsync(15_000);

      // Two phrases, not one. Each transcript announces on its own
      // `transcript:<agentId>` channel, and the announcer coalesces per
      // channel — sharing one channel would collapse these into a single
      // sentence that named neither agent.
      expect((await virtual.spokenPhraseLog()).toSorted()).toEqual(
        [
          `polite: ${t('transcript.announce.response', { role: ROLE_A })}`,
          `polite: ${t('transcript.announce.response', { role: ROLE_B })}`,
        ].toSorted(),
      );
    });
  });

  /**
   * The connection budget, as decided by this prompt and recorded beside
   * `MAX_STREAMS` in `subscriptions.ts`.
   *
   * These are the tests for that decision rather than for this component. A
   * parked conversation releasing its connection is the whole reason a chat
   * can be minimised without cost, and re-priming from history is the whole
   * reason releasing it is safe. Both are invisible in the interface, so if
   * they are not asserted here nothing else will notice them changing.
   */
  describe('the connection budget', () => {
    const historyRequests = (route: RegExp) =>
      fetchMock.mock.calls.filter(
        ([input]) => input instanceof Request && route.test(input.url),
      ).length;

    it('opens exactly one stream per conversation, and none for anything else', async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      await openTwoConversations(user);

      // One per agent, not one per component: `Transcript` is the only thing
      // in a panel that subscribes, and the heading, the dock label and the
      // message form all read the query cache it patches.
      expect(openCounts.get(streamUrls.agent(AGENT_A))).toBe(1);
      expect(openCounts.get(streamUrls.agent(AGENT_B))).toBe(1);
      expect([...openCounts.values()].reduce((a, b) => a + b, 0)).toBe(2);
    });

    it('releases every connection when the dialog is parked', async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      await openTwoConversations(user);
      await user.click(
        screen.getByRole('button', { name: t('dialog.minimise') }),
      );

      // Minimising unmounts the dialog, which unmounts both transcripts. A
      // parked conversation costs nothing; its dock button reports the agent's
      // status from the cache instead.
      expect([...openCounts.values()].reduce((a, b) => a + b, 0)).toBe(0);
    });

    it('reopens its streams and re-primes from history when restored', async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      await openTwoConversations(user);
      const before = historyRequests(HISTORY_A_ROUTE);

      await user.click(
        screen.getByRole('button', { name: t('dialog.minimise') }),
      );
      await user.click(
        screen.getByRole('button', { name: dockLabel(ROLE_A, 'idle') }),
      );
      await waitForTranscriptsReady();

      expect(openCounts.get(streamUrls.agent(AGENT_A))).toBe(1);
      expect(openCounts.get(streamUrls.agent(AGENT_B))).toBe(1);
      // This is the catch-up path, and the only one there is: nothing is held
      // across the park, so a restored conversation learns what it missed by
      // asking the server again. No `staleTime` anywhere in `endpoints.ts` is
      // what makes a remount refetch.
      expect(historyRequests(HISTORY_A_ROUTE)).toBeGreaterThan(before);
    });
  });

  describe('the "Add new" menu (003.01)', () => {
    const ROLES_ROUTE = /\/api\/company\/company-1\/roles/;
    const START_ROUTE = /\/api\/agent\/chat\/start/;
    const role = (id: string, name: string) => ({
      id,
      companyId: COMPANY_ID,
      slug: id,
      name,
      description: 'd',
      knowledgeDomains: [],
      mcpServerList: [],
      queryIndex: 0,
    });
    const respondWithMenu = () => {
      respondChat({}, [
        [
          ROLES_ROUTE,
          { body: [role('role-a', ROLE_A), role('role-b', ROLE_B)] },
        ],
        [START_ROUTE, { body: agentFixture(AGENT_B, 'idle') }],
      ]);
    };
    const addNew = () =>
      within(screen.getByRole('dialog')).getByRole('button', {
        name: t('addNew.trigger'),
      });

    it('is absent away from a company route', async () => {
      respondChat();
      const user = userEvent.setup();
      renderChat();

      await user.click(screen.getByRole('button', { name: 'Open Sales' }));
      await waitForTranscriptsReady();

      expect(
        within(screen.getByRole('dialog')).queryByRole('button', {
          name: t('addNew.trigger'),
        }),
      ).toBeNull();
    });

    it('starts a new chat as another panel in the same dialog, and focuses it', async () => {
      respondWithMenu();
      const user = userEvent.setup();
      renderChat('/company/company-1');

      await user.click(screen.getByRole('button', { name: 'Open Sales' }));
      await waitForTranscriptsReady();

      await user.click(addNew());
      await user.click(
        await screen.findByRole('menuitem', { name: t('addNew.newChat') }),
      );
      await user.click(await screen.findByRole('menuitem', { name: ROLE_B }));

      const panelB = await screen.findByRole('region', {
        name: t('chat.conversation.label', { role: ROLE_B }),
      });
      expect(
        screen.getByRole('region', {
          name: t('chat.conversation.label', { role: ROLE_A }),
        }),
      ).toBeTruthy();
      await waitFor(() => {
        expect(panelB).toHaveFocus();
      });
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('opens the task form over the chat; closing it returns to the menu with the draft intact', async () => {
      respondWithMenu();
      const user = userEvent.setup();
      renderChat('/company/company-1');

      await user.click(screen.getByRole('button', { name: 'Open Sales' }));
      await waitForTranscriptsReady();
      const field = screen.getByRole('textbox', {
        name: t('chat.message.label', { role: ROLE_A }),
      });
      await user.type(field, 'half a thought');

      await user.click(addNew());
      await user.click(
        await screen.findByRole('menuitem', { name: t('addNew.createTask') }),
      );

      const taskDialog = await screen.findByRole('dialog', {
        name: t('task.create.heading'),
      });
      await waitFor(() => {
        expect(taskDialog).toContainElement(
          document.activeElement as HTMLElement,
        );
      });

      await user.keyboard('{Escape}');

      await waitFor(() => {
        expect(
          screen.queryByRole('dialog', { name: t('task.create.heading') }),
        ).toBeNull();
      });
      // Escape closed only the top dialog: the chat is still open beneath it.
      expect(
        screen.getByRole('dialog', { name: t('chat.dialog.heading') }),
      ).toBeTruthy();
      await waitFor(() => {
        expect(addNew()).toHaveFocus();
      });
      expect(
        screen.getByRole('textbox', {
          name: t('chat.message.label', { role: ROLE_A }),
        }),
      ).toHaveValue('half a thought');
    });

    it('peels one layer per Escape: submenu, menu, then the dialog itself', async () => {
      respondWithMenu();
      const user = userEvent.setup();
      renderChat('/company/company-1');

      await user.click(screen.getByRole('button', { name: 'Open Sales' }));
      await waitForTranscriptsReady();
      addNew().focus();
      await user.keyboard('{Enter}{ArrowDown}{ArrowRight}');
      await screen.findByRole('menuitem', { name: ROLE_B });

      await user.keyboard('{Escape}');
      await waitFor(() => {
        expect(
          screen.getByRole('menuitem', { name: t('addNew.newChat') }),
        ).toHaveFocus();
      });

      await user.keyboard('{Escape}');
      await waitFor(() => {
        expect(addNew()).toHaveFocus();
      });
      expect(screen.queryByRole('menu')).toBeNull();
      expect(
        screen.getByRole('dialog', { name: t('chat.dialog.heading') }),
      ).toBeTruthy();

      await user.keyboard('{Escape}');
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
    });

    it('has no accessibility violations with the menu and its submenu open', async () => {
      respondWithMenu();
      const user = userEvent.setup();
      renderChat('/company/company-1');

      await user.click(screen.getByRole('button', { name: 'Open Sales' }));
      await waitForTranscriptsReady();
      await user.click(addNew());
      await screen.findByRole('menu');
      await expectNoA11yViolations(document.body);

      await user.click(
        screen.getByRole('menuitem', { name: t('addNew.newChat') }),
      );
      await screen.findByRole('menuitem', { name: ROLE_B });
      await expectNoA11yViolations(document.body);
    });
  });
});
