import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatProvider } from '../../../../components/ChatDialog/ChatProvider';
import { DockProvider } from '../../../../components/Dialog/DockProvider';
import { subscribe } from '../../../../events/subscriptions';
import { t } from '../../../../strings';
import {
  installFetchMock,
  respondByRoute,
} from '../../../../test-support/fetch-mock';
import { RoleDetails } from './RoleDetails';

// `RoleDetails`'s "Chat with {role}" button goes through the real
// `useChat().startChat`, unlike `VisualisationTray.test.tsx`'s mocked
// `ChatContext` — this file exists for the one thing a mock can't prove:
// that React Aria actually returns focus to this button once the chat
// dialog it opened is closed again (ADR-027). Mocked the way
// `ChatDialog.test.tsx` mocks it.
vi.mock('../../../../events/subscriptions', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../../events/subscriptions')
  >()),
  subscribe: vi.fn(),
}));

const subscribeMock = vi.mocked(subscribe);

const COMPANY_ID = 'company-1';
const ROLE_ID = 'role-1';
const ROLE_NAME = 'Sales';
const NEW_AGENT_ID = 'agent-new';
const NOW = '2026-09-01T00:00:00.000Z';

const ROLES_ROUTE = /\/api\/company\/company-1\/roles/;
const START_CHAT_ROUTE = /\/api\/agent\/chat\/start/;
const HISTORY_ROUTE = /\/api\/agent\/agent-new\/history/;
const AGENT_ROUTE = /\/api\/agent\/agent-new(\?|$)/;

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

const agentFixture = () => ({
  id: NEW_AGENT_ID,
  companyId: COMPANY_ID,
  roleId: ROLE_ID,
  assignmentId: 'assignment-1',
  status: 'idle',
  threadId: null,
  initialPrompt: 'chat',
  createdAt: NOW,
  output: null,
  updatedAt: NOW,
});

const respond = (): void => {
  respondByRoute([
    [ROLES_ROUTE, { body: [roleFixture()] }],
    [START_CHAT_ROUTE, { body: agentFixture() }],
    [HISTORY_ROUTE, { body: [] }],
    [AGENT_ROUTE, { body: agentFixture() }],
  ]);
};

const renderRoleDetails = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    queryClient,
    ...render(
      <StrictMode>
        {/*
          `ChatDialog` reads the company id off the route (its own "Add new"
          menu, out of scope here) via `useMatch`, so it needs a router even
          though this test never navigates — same reason
          `ChatDialog.test.tsx`'s `renderChat` wraps in one. The default `/`
          is not a company route, so that menu stays out of this test.
        */}
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <DockProvider>
              <ChatProvider>
                <RoleDetails
                  companyId={COMPANY_ID}
                  roleId={ROLE_ID}
                  headingId="tray-heading"
                />
              </ChatProvider>
            </DockProvider>
          </QueryClientProvider>
        </MemoryRouter>
      </StrictMode>,
    ),
  };
};

describe('RoleDetails, chatting with a real ChatProvider', () => {
  beforeEach(() => {
    installFetchMock();
    subscribeMock.mockImplementation(() => () => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns focus to the "Chat with" button once the opened chat is closed', async () => {
    respond();
    const user = userEvent.setup();
    renderRoleDetails();

    const chatButton = await screen.findByRole('button', {
      name: t('visualisation.tray.chatWithRole', { role: ROLE_NAME }),
    });
    await user.click(chatButton);

    await screen.findByRole('region', {
      name: t('chat.conversation.label', { role: ROLE_NAME }),
    });

    await user.click(
      screen.getByRole('button', {
        name: t('chat.close', { role: ROLE_NAME }),
      }),
    );

    expect(screen.queryByRole('dialog')).toBeNull();
    // React Aria's `Modal` returns focus to whatever opened it once the
    // overlay unmounts — the same mechanism `ChatDialog.test.tsx` proves for
    // its own opener, exercised here through `RoleDetails`'s real button
    // rather than a test-only stand-in.
    await waitFor(() => {
      expect(document.activeElement).toBe(chatButton);
    });
  });
});
