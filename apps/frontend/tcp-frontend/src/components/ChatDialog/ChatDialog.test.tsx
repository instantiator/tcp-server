import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuditWireEvent, WireEvent } from '@tcp/shared/client';
import { StrictMode } from 'react';
import { Button } from 'react-aria-components';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../../auth/session';
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
import { eavesdropStorageKey } from './eavesdropStorage';
import { useChat, type Conversation } from './useChat';

// Keyed by url, so a test can see how many streams are open for each agent.
vi.mock('../../events/subscriptions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../events/subscriptions')>()),
  subscribe: vi.fn(),
}));

const subscribeMock = vi.mocked(subscribe);

const COMPANY_ID = 'company-1';
const USER_ID = 'user-1';
const OLDER = '2026-08-10T09:00:00.000Z';
const NEWER = '2026-08-10T10:00:00.000Z';

const SALES = { agentId: 'agent-a', roleId: 'role-a', roleName: 'Sales' };
const LEGAL = { agentId: 'agent-b', roleId: 'role-b', roleName: 'Legal' };
const WORKER = { agentId: 'agent-c', roleId: 'role-c', roleName: 'Writer' };

const openCounts = new Map<string, number>();
const emitters = new Map<string, (event: WireEvent) => void>();

/** How many streams are open across every agent's transcript. */
const openTranscriptStreams = (): number =>
  [SALES, LEGAL, WORKER].reduce(
    (sum, { agentId }) =>
      sum + (openCounts.get(streamUrls.agent(agentId)) ?? 0),
    0,
  );

const agent = (agentId: string, status: string, updatedAt = OLDER) => ({
  id: agentId,
  companyId: COMPANY_ID,
  roleId: 'role',
  assignmentId: `assignment-${agentId}`,
  status,
  threadId: null,
  initialPrompt: '',
  createdAt: OLDER,
  output: null,
  updatedAt,
});

const chatAssignment = (
  { agentId, roleId }: { agentId: string; roleId: string },
  updatedAt: string,
) => ({
  id: `assignment-${agentId}`,
  companyId: COMPANY_ID,
  roleId,
  agentId,
  mode: 'chat',
  status: 'in-progress',
  shortcode: null,
  createdAt: OLDER,
  updatedAt,
});

const history = (agentId: string, text: string): AuditWireEvent[] => [
  {
    id: `audit-${agentId}`,
    timestamp: OLDER,
    companyId: COMPANY_ID,
    role: 'user',
    agentId,
    assignmentId: null,
    taskId: null,
    eventType: 'input',
    payload: { text },
  },
];

interface Routes {
  readonly statuses?: Readonly<Record<string, string>>;
  readonly search?: readonly string[];
  readonly running?: boolean;
  /** HTTP status for sending a message and for completing. */
  readonly messageStatus?: number;
  readonly completeStatus?: number;
}

/** Answers every route the dialog reaches. Sales is newer than Legal. */
const respond = ({
  statuses = {},
  search = [],
  running = false,
  messageStatus = 202,
  completeStatus = 200,
}: Routes = {}): void => {
  const status = (id: string, fallback: string) => statuses[id] ?? fallback;
  const routes: (readonly [RegExp, RouteResponse])[] = [
    [/\/api\/agent\/search/, { body: { agentIds: search } }],
    [/\/api\/agent\/[^/?]+\/chat/, { status: 204, body: undefined }],
    [
      /\/api\/agent\/[^/?]+\/message/,
      { status: messageStatus, body: undefined },
    ],
    [
      /\/api\/agent\/agent-a\/complete/,
      { status: completeStatus, body: agent(SALES.agentId, 'completed') },
    ],
    [
      /\/api\/agent\/agent-a\/history/,
      { body: history(SALES.agentId, 'Hello Sales') },
    ],
    [
      /\/api\/agent\/agent-b\/history/,
      { body: history(LEGAL.agentId, 'Hello Legal') },
    ],
    [
      /\/api\/agent\/agent-c\/history/,
      { body: history(WORKER.agentId, 'Drafting') },
    ],
    [
      /\/api\/agent\/agent-a(\?|$)/,
      { body: agent(SALES.agentId, status(SALES.agentId, 'idle')) },
    ],
    [
      /\/api\/agent\/agent-b(\?|$)/,
      { body: agent(LEGAL.agentId, status(LEGAL.agentId, 'idle')) },
    ],
    [
      /\/api\/agent\/agent-c(\?|$)/,
      { body: agent(WORKER.agentId, status(WORKER.agentId, 'running')) },
    ],
    [
      /\/api\/agent\?/,
      {
        body: [
          agent(SALES.agentId, status(SALES.agentId, 'idle'), NEWER),
          agent(LEGAL.agentId, status(LEGAL.agentId, 'idle')),
          agent(WORKER.agentId, status(WORKER.agentId, 'running')),
        ],
      },
    ],
    [
      /\/api\/assignment\?.*mode=chat/,
      {
        body: [chatAssignment(SALES, NEWER), chatAssignment(LEGAL, OLDER)],
      },
    ],
    [
      /\/api\/assignment\?/,
      {
        body: running
          ? [
              {
                ...chatAssignment(WORKER, OLDER),
                mode: 'implement',
                shortcode: '001-002',
              },
            ]
          : [],
      },
    ],
    [
      /\/api\/company\/company-1\/roles/,
      {
        body: [SALES, LEGAL, WORKER].map(({ roleId, roleName }) => ({
          id: roleId,
          name: roleName,
          companyId: COMPANY_ID,
        })),
      },
    ],
  ];
  respondByRoute(routes);
};

const SALES_CHAT: Conversation = {
  agentId: SALES.agentId,
  roleName: SALES.roleName,
  reference: null,
};
const WORKER_LISTEN: Conversation = {
  agentId: WORKER.agentId,
  roleName: WORKER.roleName,
  reference: '001-002',
  readOnly: true,
};

/** Page controls standing in for the app's openers. */
const Openers = () => {
  const { openChat } = useChat();
  return (
    <>
      <Button
        className="react-aria-Button"
        onPress={() => {
          openChat(SALES_CHAT);
        }}
      >
        Open Sales
      </Button>
      <Button
        className="react-aria-Button"
        onPress={() => {
          openChat(WORKER_LISTEN);
        }}
      >
        Listen in to Writer
      </Button>
    </>
  );
};

const renderChat = ({ session = true } = {}) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (
    <StrictMode>
      <MemoryRouter initialEntries={[`/company/${COMPANY_ID}`]}>
        <QueryClientProvider client={queryClient}>
          <SessionProvider session={session ? { userId: USER_ID } : null}>
            <DockProvider>
              <ChatProvider>
                <Openers />
              </ChatProvider>
            </DockProvider>
          </SessionProvider>
        </QueryClientProvider>
      </MemoryRouter>
    </StrictMode>
  );
  return render(tree);
};

const dialog = () =>
  screen.getByRole('dialog', { name: t('chat.dialog.heading') });
const list = () =>
  within(dialog()).getByRole('listbox', { name: t('chat.dialog.heading') });
const row = (name: RegExp) => within(list()).getByRole('option', { name });

/** Opens Sales and waits for its list and transcript to settle. */
const openSales = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: 'Open Sales' }));
  await within(dialog()).findByRole('option', { name: /Sales/ });
  await within(dialog()).findByText('Hello Sales');
};

describe('ChatDialog', () => {
  beforeEach(() => {
    localStorage.clear();
    installFetchMock();
    openCounts.clear();
    emitters.clear();
    subscribeMock.mockImplementation((url, onEvent) => {
      openCounts.set(url, (openCounts.get(url) ?? 0) + 1);
      emitters.set(url, onEvent);
      return () => {
        openCounts.set(url, (openCounts.get(url) ?? 0) - 1);
      };
    });
  });

  it('opens on the chosen chat: selected in the list, its view beside it', async () => {
    respond();
    const user = userEvent.setup();
    renderChat();
    await openSales(user);

    expect(row(/Sales/)).toHaveAttribute('aria-selected', 'true');
    expect(
      within(dialog()).getByRole('heading', {
        name: t('chat.conversation.label', { role: 'Sales' }),
      }),
    ).toBeInTheDocument();
    expect(
      within(dialog()).getByRole('textbox', {
        name: t('chat.message.label', { role: 'Sales' }),
      }),
    ).toBeInTheDocument();
    expect(
      within(dialog()).getByRole('button', { name: t('dialog.minimise') }),
    ).toBeInTheDocument();
    expect(
      within(dialog()).getByRole('button', { name: t('dialog.close') }),
    ).toBeInTheDocument();
  });

  it('lists chats newest first, under their group heading', async () => {
    respond();
    const user = userEvent.setup();
    renderChat();
    await openSales(user);

    const chats = within(list()).getByRole('group', {
      name: t('chat.list.group.chats'),
    });
    const names = within(chats)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(names[0]).toContain('Sales');
    expect(names[1]).toContain('Legal');
  });

  it('shows one view at a time, and so holds one transcript stream', async () => {
    respond();
    const user = userEvent.setup();
    renderChat();
    await openSales(user);
    expect(openTranscriptStreams()).toBe(1);

    await user.click(row(/Legal/));
    await within(dialog()).findByText('Hello Legal');
    expect(within(dialog()).queryByText('Hello Sales')).toBeNull();
    expect(openTranscriptStreams()).toBe(1);
    expect(openCounts.get(streamUrls.agent(SALES.agentId))).toBe(0);
  });

  it('sends a message from the view', async () => {
    respond();
    const user = userEvent.setup();
    renderChat();
    await openSales(user);

    await user.type(
      within(dialog()).getByRole('textbox', {
        name: t('chat.message.label', { role: 'Sales' }),
      }),
      'How are sales?',
    );
    await user.click(
      within(dialog()).getByRole('button', { name: t('chat.send') }),
    );

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input instanceof Request ? input.url : input).includes(
            '/api/agent/agent-a/message',
          ),
        ),
      ).toBe(true);
    });
  });

  describe('the message form and Archive', () => {
    const field = () =>
      within(dialog()).getByRole('textbox', {
        name: t('chat.message.label', { role: 'Sales' }),
      });
    const archive = () =>
      within(dialog()).queryByRole('button', {
        name: t('chat.complete', { role: 'Sales' }),
      });
    const posted = (path: string) =>
      fetchMock.mock.calls.some(([input]) =>
        String(input instanceof Request ? input.url : input).includes(path),
      );

    it('says it is waiting, and disables the field and Archive, while a turn runs', async () => {
      respond({ statuses: { [SALES.agentId]: 'running' } });
      const user = userEvent.setup();
      renderChat();
      await openSales(user);

      await within(dialog()).findByText(t('chat.waiting', { role: 'Sales' }));
      expect(field()).toBeDisabled();
      expect(archive()).toBeDisabled();
    });

    it('sends nothing for an empty field', async () => {
      respond();
      const user = userEvent.setup();
      renderChat();
      await openSales(user);

      await user.click(
        within(dialog()).getByRole('button', { name: t('chat.send') }),
      );
      expect(posted('/api/agent/agent-a/message')).toBe(false);
    });

    it('keeps the typed text when a send fails', async () => {
      respond({ messageStatus: 500 });
      const user = userEvent.setup();
      renderChat();
      await openSales(user);

      await user.type(field(), 'Still here');
      await user.click(
        within(dialog()).getByRole('button', { name: t('chat.send') }),
      );
      await within(dialog()).findByText(t('chat.send.failed'));
      expect(field()).toHaveValue('Still here');
    });

    it('has no Archive once the chat is over, and says so instead of the form', async () => {
      respond({ statuses: { [SALES.agentId]: 'completed' } });
      const user = userEvent.setup();
      renderChat();
      await user.click(screen.getByRole('button', { name: 'Open Sales' }));
      await within(dialog()).findByText(t('chat.done'));
      expect(archive()).toBeNull();
    });

    it('shows the failure and keeps the view when archiving fails', async () => {
      respond({ completeStatus: 500 });
      const user = userEvent.setup();
      renderChat();
      await openSales(user);

      const button = archive();
      expect(button).not.toBeNull();
      await user.click(button as HTMLElement);
      await within(dialog()).findByText(t('chat.complete.failed'));
      expect(within(dialog()).getByText('Hello Sales')).toBeInTheDocument();
    });
  });

  it('archives a role chat by completing it, then returns focus to the list', async () => {
    respond();
    const user = userEvent.setup();
    renderChat();
    await openSales(user);

    await user.click(
      within(dialog()).getByRole('button', {
        name: t('chat.complete', { role: 'Sales' }),
      }),
    );
    await waitFor(() => {
      expect(list()).toContainElement(document.activeElement as HTMLElement);
    });
  });

  it('hides completed chats until "Show archived" is ticked', async () => {
    respond({ statuses: { [LEGAL.agentId]: 'completed' } });
    const user = userEvent.setup();
    renderChat();
    await openSales(user);

    await waitFor(() => {
      expect(
        within(list()).queryByRole('option', { name: /Legal/ }),
      ).toBeNull();
    });
    const box = within(dialog()).getByRole('checkbox', {
      name: t('chat.list.showArchived'),
    });
    await user.click(box);
    expect(row(/Legal/)).toBeInTheDocument();
  });

  describe('listening in', () => {
    it('shows a read-only view under "running", with no message field', async () => {
      respond();
      const user = userEvent.setup();
      renderChat();
      await user.click(
        screen.getByRole('button', { name: 'Listen in to Writer' }),
      );
      await within(dialog()).findByText('Drafting');

      const running = within(list()).getByRole('group', {
        name: t('chat.list.group.running'),
      });
      expect(
        within(running).getByRole('option', { name: /Writer/ }),
      ).toHaveAttribute('aria-selected', 'true');
      expect(
        within(dialog()).queryByRole('textbox', {
          name: t('chat.message.label', { role: 'Writer' }),
        }),
      ).toBeNull();
      expect(
        within(dialog()).queryByRole('button', {
          name: t('chat.delete', { role: 'Writer' }),
        }),
      ).toBeNull();
    });

    it('archives without stopping the agent, and comes back when chosen again', async () => {
      respond();
      const user = userEvent.setup();
      renderChat();
      await user.click(
        screen.getByRole('button', { name: 'Listen in to Writer' }),
      );
      await within(dialog()).findByText('Drafting');

      await user.click(
        within(dialog()).getByRole('button', {
          name: t('chat.archive.listening', { role: 'Writer' }),
        }),
      );
      expect(
        within(list()).queryByRole('option', { name: /Writer/ }),
      ).toBeNull();
      // Listening in never stops the agent: no server call was made for it.
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input instanceof Request ? input.url : input).includes(
            'agent-c/complete',
          ),
        ),
      ).toBe(false);

      await user.click(
        within(dialog()).getByRole('checkbox', {
          name: t('chat.list.showArchived'),
        }),
      );
      await user.click(row(/Writer/));
      await user.click(
        within(dialog()).getByRole('checkbox', {
          name: t('chat.list.showArchived'),
        }),
      );
      expect(row(/Writer/)).toBeInTheDocument();
    });

    it('is remembered per user and company across a remount', async () => {
      respond();
      const user = userEvent.setup();
      const first = renderChat();
      await user.click(
        screen.getByRole('button', { name: 'Listen in to Writer' }),
      );
      await within(dialog()).findByText('Drafting');
      first.unmount();

      const stored = localStorage.getItem(
        eavesdropStorageKey(USER_ID, COMPANY_ID),
      );
      expect(stored).toContain(WORKER.agentId);

      renderChat();
      await openSales(user);
      expect(row(/Writer/)).toBeInTheDocument();
    });

    it('ignores a corrupt stored list', async () => {
      localStorage.setItem(eavesdropStorageKey(USER_ID, COMPANY_ID), '{oops');
      respond();
      const user = userEvent.setup();
      renderChat();
      await openSales(user);
      expect(
        within(list()).queryByRole('option', { name: /Writer/ }),
      ).toBeNull();
    });
  });

  describe('deleting a chat', () => {
    const pressDelete = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(
        within(dialog()).getByRole('button', {
          name: t('chat.delete', { role: 'Sales' }),
        }),
      );
      return screen.findByRole('alertdialog', {
        name: t('chat.delete.confirm.heading'),
      });
    };

    const deleteCalls = () =>
      fetchMock.mock.calls.filter(([input]) =>
        String(input instanceof Request ? input.url : input).includes(
          '/api/agent/agent-a/chat',
        ),
      );

    it('asks first, and keeps the chat on "no"', async () => {
      respond();
      const user = userEvent.setup();
      renderChat();
      await openSales(user);

      const confirm = await pressDelete(user);
      await user.click(
        within(confirm).getByRole('button', {
          name: t('chat.delete.confirm.reject'),
        }),
      );
      expect(deleteCalls()).toHaveLength(0);
      expect(within(dialog()).getByText('Hello Sales')).toBeInTheDocument();
    });

    it('deletes on "yes", leaving the empty view and focus in the list', async () => {
      respond();
      const user = userEvent.setup();
      renderChat();
      await openSales(user);

      const confirm = await pressDelete(user);
      await user.click(
        within(confirm).getByRole('button', {
          name: t('chat.delete.confirm.accept'),
        }),
      );
      await within(dialog()).findByRole('heading', {
        name: t('chat.view.empty.heading'),
      });
      expect(deleteCalls()).toHaveLength(1);
      await waitFor(() => {
        expect(list()).toContainElement(document.activeElement as HTMLElement);
      });
    });

    it('is refused while the agent is mid-turn', async () => {
      respond({ statuses: { [SALES.agentId]: 'running' } });
      const user = userEvent.setup();
      renderChat();
      await openSales(user);
      await waitFor(() => {
        expect(
          within(dialog()).getByRole('button', {
            name: t('chat.delete', { role: 'Sales' }),
          }),
        ).toBeDisabled();
      });
    });
  });

  describe('search', () => {
    const search = () =>
      within(dialog()).getByRole('searchbox', {
        name: t('chat.search.label'),
      });

    it('filters by name', async () => {
      respond();
      const user = userEvent.setup();
      renderChat();
      await openSales(user);

      await user.type(search(), 'leg');
      await waitFor(() => {
        expect(
          within(list()).queryByRole('option', { name: /Sales/ }),
        ).toBeNull();
      });
      expect(row(/Legal/)).toBeInTheDocument();
    });

    it('also keeps chats whose transcript matches', async () => {
      respond({ search: [SALES.agentId] });
      const user = userEvent.setup();
      renderChat();
      await openSales(user);

      await user.type(search(), 'pricing');
      await waitFor(() => {
        expect(
          within(list()).queryByRole('option', { name: /Legal/ }),
        ).toBeNull();
      });
      // No title says "pricing": Sales stays only because its transcript does.
      await within(list()).findByRole('option', { name: /Sales/ });
    });
  });

  it('minimises to one dock entry, and restores the same view', async () => {
    respond();
    const user = userEvent.setup();
    renderChat();
    await openSales(user);

    await user.click(
      within(dialog()).getByRole('button', { name: t('dialog.minimise') }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      screen.getAllByRole('button', { name: t('chat.dialog.heading') }),
    ).toHaveLength(1);
    expect(openTranscriptStreams()).toBe(0);

    await user.click(
      screen.getByRole('button', { name: t('chat.dialog.heading') }),
    );
    await within(dialog()).findByText('Hello Sales');
    expect(row(/Sales/)).toHaveAttribute('aria-selected', 'true');
  });

  it('closes on escape, leaving nothing docked', async () => {
    respond();
    const user = userEvent.setup();
    renderChat();
    await openSales(user);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('offers a chat with a role or listening in from Add new', async () => {
    respond({ running: true });
    const user = userEvent.setup();
    renderChat();
    await openSales(user);

    await user.click(
      within(dialog()).getByRole('button', { name: t('addNew.trigger') }),
    );
    await user.click(
      screen.getByRole('menuitem', { name: t('addNew.listenIn') }),
    );
    await user.click(
      await screen.findByRole('menuitem', {
        name: t('addNew.listenIn.option', {
          role: 'Writer',
          reference: '001-002',
        }),
      }),
    );
    await within(dialog()).findByText('Drafting');
    expect(row(/Writer/)).toHaveAttribute('aria-selected', 'true');
  });

  it('has no accessibility violations', async () => {
    respond();
    const user = userEvent.setup();
    renderChat();
    await openSales(user);
    await expectNoA11yViolations(document.body);
  });
});
