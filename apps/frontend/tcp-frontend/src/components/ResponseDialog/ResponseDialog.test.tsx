import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useState } from 'react';
import { Button } from 'react-aria-components';
import { beforeEach, describe, expect, it } from 'vitest';
import type { components } from '../../api/schema';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import {
  fetchMock,
  installFetchMock,
  respondByRoute,
  type RouteResponse,
} from '../../test-support/fetch-mock';
import { ResponseDialog } from './ResponseDialog';

type Conversation = components['schemas']['ConversationDetailResponseDto'];
type ConversationMessage =
  components['schemas']['ConversationMessageResponseDto'];

const SLUG = 'enquiry-1';
const NOW = '2026-08-10T09:00:00.000Z';

const CONVERSATION_ROUTE = new RegExp(`/api/conversation/${SLUG}$`);
const REPLY_ROUTE = new RegExp(`/api/conversation/${SLUG}/reply$`);

const messageFixture = (
  overrides: Partial<ConversationMessage> = {},
): ConversationMessage => ({
  id: 'msg-1',
  conversationId: 'conv-1',
  author: 'user',
  authorIdentifier: null,
  content: 'Hello',
  timestamp: NOW,
  ...overrides,
});

const conversationFixture = (
  overrides: Partial<Conversation> = {},
): Conversation => ({
  id: 'conv-1',
  slug: SLUG,
  companyId: 'company-1',
  roleName: 'Sales',
  roleId: 'role-1',
  agentId: 'agent-1',
  question: 'What is the budget?',
  context: null,
  status: 'awaiting_user',
  routedToIdentifiers: [],
  createdAt: NOW,
  messages: [],
  companyTimezone: null,
  ...overrides,
});

interface EnquiryRoutes {
  readonly conversation?: RouteResponse;
  readonly reply?: RouteResponse;
}

/** Answers both routes this dialog can reach: the conversation and its reply. */
const respondEnquiry = (overrides: EnquiryRoutes = {}): void => {
  respondByRoute([
    [REPLY_ROUTE, overrides.reply ?? { body: conversationFixture() }],
    [
      CONVERSATION_ROUTE,
      overrides.conversation ?? { body: conversationFixture() },
    ],
  ]);
};

/**
 * A real, keyboard-reachable control that opens the dialog — so React Aria's
 * dialog has something to return focus to on close, and StrictMode's double
 * effect invocation is exercised the same way a real page would trigger it.
 */
const Opener = () => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        className="react-aria-Button"
        onPress={() => {
          setOpen(true);
        }}
      >
        Open
      </Button>
      {open && (
        <ResponseDialog
          slug={SLUG}
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </>
  );
};

const renderResponseDialog = () => {
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

/** No progressbar anywhere — the conversation has resolved. */
const waitForReady = () =>
  waitFor(() => {
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

const openDialog = async (
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> => {
  await user.click(screen.getByRole('button', { name: 'Open' }));
  await waitForReady();
};

const requestCount = (route: RegExp) =>
  fetchMock.mock.calls.filter(([input]) => {
    const url = input instanceof Request ? input.url : String(input);
    return route.test(url);
  }).length;

const replyField = () =>
  screen.getByRole('textbox', { name: t('enquiry.reply.label') });

const sendButton = () =>
  screen.getByRole('button', { name: t('enquiry.reply.send') });

describe('ResponseDialog', () => {
  beforeEach(() => {
    installFetchMock();
  });

  it('shows a loading state while the enquiry is loading', async () => {
    // Never resolved — the assertion happens before it would be.
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    const user = userEvent.setup();
    renderResponseDialog();

    await user.click(screen.getByRole('button', { name: 'Open' }));

    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('shows an error state when the enquiry fails to load', async () => {
    respondEnquiry({
      conversation: { status: 500, body: { message: 'boom' } },
    });
    const user = userEvent.setup();
    renderResponseDialog();

    await user.click(screen.getByRole('button', { name: 'Open' }));

    expect(await screen.findByText(t('enquiry.error'))).toBeInTheDocument();
  });

  it('shows an empty state when the conversation has no messages yet', async () => {
    respondEnquiry({
      conversation: { body: conversationFixture({ messages: [] }) },
    });
    const user = userEvent.setup();
    renderResponseDialog();

    await openDialog(user);

    expect(
      screen.getByText(t('enquiry.messages.empty.heading')),
    ).toBeInTheDocument();
    expect(
      screen.getByText(t('enquiry.messages.empty.body')),
    ).toBeInTheDocument();
  });

  it('answers the question: types, submits, and shows the sent confirmation', async () => {
    respondEnquiry({
      conversation: {
        body: conversationFixture({ messages: [messageFixture()] }),
      },
    });
    const user = userEvent.setup();
    renderResponseDialog();
    await openDialog(user);

    await user.type(replyField(), 'Here is the answer');
    await user.click(sendButton());

    expect(
      await screen.findByText(t('enquiry.reply.sent')),
    ).toBeInTheDocument();
    // The form is gone, not merely the button — a second submit is meaningless
    // once the reply has been recorded.
    expect(
      screen.queryByRole('button', { name: t('enquiry.reply.send') }),
    ).toBeNull();
    expect(
      screen.queryByRole('textbox', { name: t('enquiry.reply.label') }),
    ).toBeNull();
  });

  it('rejects an empty answer: shows the required message, sends no request, and focuses the field', async () => {
    respondEnquiry();
    const user = userEvent.setup();
    renderResponseDialog();
    await openDialog(user);

    await user.type(replyField(), '   ');
    const before = requestCount(REPLY_ROUTE);
    await user.click(sendButton());

    const field = replyField();
    expect(field).toHaveAccessibleDescription(t('enquiry.reply.required'));
    expect(field).toHaveFocus();
    expect(requestCount(REPLY_ROUTE)).toBe(before);
  });

  it('shows already-answered on a 409, and removes the send control', async () => {
    respondEnquiry({ reply: { status: 409, body: { message: 'closed' } } });
    const user = userEvent.setup();
    renderResponseDialog();
    await openDialog(user);

    await user.type(replyField(), 'an answer');
    await user.click(sendButton());

    expect(
      await screen.findByText(t('enquiry.reply.alreadyAnswered')),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: t('enquiry.reply.send') }),
    ).toBeNull();
  });

  it('shows the question is gone on a 404', async () => {
    respondEnquiry({ reply: { status: 404, body: { message: 'nope' } } });
    const user = userEvent.setup();
    renderResponseDialog();
    await openDialog(user);

    await user.type(replyField(), 'an answer');
    await user.click(sendButton());

    expect(
      await screen.findByText(t('enquiry.reply.gone')),
    ).toBeInTheDocument();
  });

  it('shows a generic failure on a 500', async () => {
    respondEnquiry({ reply: { status: 500, body: { message: 'boom' } } });
    const user = userEvent.setup();
    renderResponseDialog();
    await openDialog(user);

    await user.type(replyField(), 'an answer');
    await user.click(sendButton());

    expect(
      await screen.findByText(t('enquiry.reply.failed')),
    ).toBeInTheDocument();
  });

  it('is operable keyboard-only: reaching the field and sending without a mouse', async () => {
    respondEnquiry({
      conversation: {
        body: conversationFixture({ messages: [messageFixture()] }),
      },
    });
    const user = userEvent.setup();
    renderResponseDialog();

    await user.tab();
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitForReady();

    const field = replyField();
    // React Aria autofocuses somewhere inside the dialog on open; bounded
    // tabbing finds the field regardless of exactly where that lands.
    for (let i = 0; i < 10 && document.activeElement !== field; i += 1) {
      await user.tab();
    }
    expect(field).toHaveFocus();

    await user.keyboard('A keyboard-only answer');
    expect(field).toHaveValue('A keyboard-only answer');

    await user.tab();
    expect(sendButton()).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(
      await screen.findByText(t('enquiry.reply.sent')),
    ).toBeInTheDocument();
  });

  it('returns focus to the opener when the dialog closes', async () => {
    respondEnquiry();
    const user = userEvent.setup();
    renderResponseDialog();
    await openDialog(user);

    await user.click(screen.getByRole('button', { name: t('dialog.close') }));

    // React Aria's own doing: `ModalOverlay` restores focus to whatever opened
    // it when the overlay unmounts.
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Open' }),
      );
    });
  });

  describe('message timestamps', () => {
    it("renders a message's time in the company's own zone, distinct from no zone at all", async () => {
      respondEnquiry({
        conversation: {
          body: conversationFixture({
            messages: [messageFixture()],
            companyTimezone: 'Pacific/Auckland',
          }),
        },
      });
      const user = userEvent.setup();
      const first = renderResponseDialog();
      await openDialog(user);
      const withZoneText = document.querySelector('time')?.textContent;
      expect(withZoneText).toBeTruthy();
      first.unmount();

      installFetchMock();
      respondEnquiry({
        conversation: {
          body: conversationFixture({
            messages: [messageFixture()],
            companyTimezone: null,
          }),
        },
      });
      renderResponseDialog();
      await openDialog(userEvent.setup());
      const withoutZoneText = document.querySelector('time')?.textContent;

      expect(withoutZoneText).toBeTruthy();
      expect(withoutZoneText).not.toBe(withZoneText);
    });

    it('falls back rather than blanking the dialog when the zone is invalid', async () => {
      respondEnquiry({
        conversation: {
          body: conversationFixture({
            messages: [messageFixture()],
            companyTimezone: 'Not/AZone',
          }),
        },
      });
      const user = userEvent.setup();
      renderResponseDialog();
      await openDialog(user);

      expect(document.querySelector('time')?.textContent).toBeTruthy();
      expect(screen.getByText('Hello')).toBeInTheDocument();
    });
  });

  describe('accessibility', () => {
    it('has no violations once loaded', async () => {
      respondEnquiry({
        conversation: {
          body: conversationFixture({ messages: [messageFixture()] }),
        },
      });
      const user = userEvent.setup();
      renderResponseDialog();
      await openDialog(user);

      // React Aria's `Modal` portals out of the render container, so the scan
      // has to cover `document.body`.
      await expectNoA11yViolations(document.body);
    });

    it('has no violations with the validation error showing', async () => {
      respondEnquiry();
      const user = userEvent.setup();
      renderResponseDialog();
      await openDialog(user);

      await user.click(sendButton());
      await screen.findByText(t('enquiry.reply.required'));

      await expectNoA11yViolations(document.body);
    });
  });
});
