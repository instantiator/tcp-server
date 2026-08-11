import { virtual } from '@guidepup/virtual-screen-reader';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WireEvent } from '@tcp/shared/client';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveCompanyEnquiriesList } from '../../../api/hooks';
import { applyEvent } from '../../../events/cache';
import { t } from '../../../strings';
import {
  installFetchMock,
  respondByRoute,
} from '../../../test-support/fetch-mock';
import { NewEnquiryNotifications } from './NewEnquiryNotifications';

const COMPANY_ID = 'company-1';
const NOW = '2026-08-10T09:00:00.000Z';

const CONVERSATIONS_ROUTE = /\/api\/conversation\?/;

interface ConversationOverrides {
  readonly id: string;
  readonly roleName?: string;
  readonly question?: string;
}

const conversation = (overrides: ConversationOverrides) => ({
  id: overrides.id,
  slug: overrides.id,
  companyId: COMPANY_ID,
  roleName: overrides.roleName ?? 'Sales',
  roleId: 'role-1',
  agentId: 'agent-1',
  question: overrides.question ?? `${overrides.id} question`,
  context: null,
  status: 'awaiting_user',
  routedToIdentifiers: [],
  createdAt: NOW,
});

/** Answers the one query this view and its test harness both make. */
const respondEnquiries = (
  list: readonly ReturnType<typeof conversation>[],
): void => {
  respondByRoute([[CONVERSATIONS_ROUTE, { body: list }]]);
};

/** An `EnquiryChangeSummary`, built from the conversation it patches. */
const enquirySummary = (row: ReturnType<typeof conversation>) => ({
  id: row.id,
  slug: row.slug,
  status: row.status,
  roleName: row.roleName,
  question: row.question,
});

/** A live `enquiry` `state_change`, as `useEventStream` hands to `applyEvent`. */
const auditEvent = (payload: Record<string, unknown>): WireEvent => ({
  type: 'audit',
  event: {
    timestamp: NOW,
    companyId: COMPANY_ID,
    role: 'system',
    agentId: null,
    assignmentId: null,
    taskId: null,
    eventType: 'state_change',
    payload,
  },
});

/**
 * Reads the same query the component under test does, so a test can wait for
 * it to settle before asserting "nothing rendered" actually means "loaded and
 * still nothing" rather than "still loading".
 */
const LoadMarker = ({ companyId }: { readonly companyId: string }) => {
  const query = useLiveCompanyEnquiriesList(companyId, 'awaiting_user');
  return <p>{query.isSuccess ? 'ready' : 'loading'}</p>;
};

const renderNotifications = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    queryClient,
    ...render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <LoadMarker companyId={COMPANY_ID} />
            <NewEnquiryNotifications companyId={COMPANY_ID} />
          </MemoryRouter>
        </QueryClientProvider>
      </StrictMode>,
    ),
  };
};

const waitForReady = () => screen.findByText('ready');

describe('NewEnquiryNotifications', () => {
  beforeEach(() => {
    installFetchMock();
  });

  it('shows no notification for an enquiry already present on first load', async () => {
    respondEnquiries([conversation({ id: 'conv-1' })]);
    renderNotifications();

    await waitForReady();

    // What's already there when the page loads is not an arrival — nothing
    // to notify about, and nothing to dismiss.
    expect(
      screen.queryByRole('group', { name: t('notification.label') }),
    ).toBeNull();
  });

  it('shows one notification for an enquiry that arrives afterwards, with a working link and dismiss', async () => {
    respondEnquiries([]);
    const user = userEvent.setup();
    const { queryClient } = renderNotifications();
    await waitForReady();
    expect(
      screen.queryByRole('group', { name: t('notification.label') }),
    ).toBeNull();

    const arrived = conversation({ id: 'conv-2', roleName: 'Legal' });
    respondEnquiries([arrived]);
    act(() => {
      applyEvent(
        queryClient,
        auditEvent({ entity: 'enquiry', summary: enquirySummary(arrived) }),
      );
    });

    const group = await screen.findByRole('group', {
      name: t('notification.label'),
    });
    expect(
      within(group).getByText(
        t('activity.enquiries.notification', { role: 'Legal' }),
      ),
    ).toBeInTheDocument();

    const link = within(group).getByRole('link', {
      name: t('activity.enquiries.notification.link'),
    });
    expect(link).toHaveAttribute('href', `/company/${COMPANY_ID}#enquiries`);

    await user.click(
      within(group).getByRole('button', { name: t('notification.dismiss') }),
    );
    expect(
      screen.queryByRole('group', { name: t('notification.label') }),
    ).toBeNull();
  });

  it('drops the notification when the enquiry leaves the list', async () => {
    respondEnquiries([]);
    const { queryClient } = renderNotifications();
    await waitForReady();

    const arrived = conversation({ id: 'conv-3', roleName: 'Support' });
    respondEnquiries([arrived]);
    act(() => {
      applyEvent(
        queryClient,
        auditEvent({ entity: 'enquiry', summary: enquirySummary(arrived) }),
      );
    });
    await screen.findByRole('group', { name: t('notification.label') });

    // The list is refetched and no longer includes it — the general path
    // `applyEvent` takes for an `enquiry` change it cannot patch a cached row
    // for: an unmatched id, or no `summary` at all. It invalidates the list
    // and lets the next `GET` answer honestly.
    //
    // The other shape — a same-id `state_change`, which is what a real
    // "closed by reply" event actually carries — is covered by the test
    // below, because it never removes the row and so needs the component's
    // own status filter to be dropped.
    respondEnquiries([]);
    act(() => {
      applyEvent(queryClient, auditEvent({ entity: 'enquiry' }));
    });

    await vi.waitFor(() => {
      expect(
        screen.queryByRole('group', { name: t('notification.label') }),
      ).toBeNull();
    });
  });

  // The real "someone else answered it" path, and the one a live deployment
  // actually takes. Every backend publisher of an `enquiry` state change sends
  // a `summary` carrying the same id, so `applyEvent` patches the cached row's
  // `status` in place and never removes it from the list — the row is still
  // there, now reading `closed`. Only the component's own status filter drops
  // the notification. Without that filter this test fails and the stale
  // notification sits there until dismissed by hand.
  it('drops the notification when the enquiry is closed in place by a live event', async () => {
    respondEnquiries([]);
    const { queryClient } = renderNotifications();
    await waitForReady();

    const arrived = conversation({ id: 'conv-4', roleName: 'Support' });
    respondEnquiries([arrived]);
    act(() => {
      applyEvent(
        queryClient,
        auditEvent({ entity: 'enquiry', summary: enquirySummary(arrived) }),
      );
    });
    await screen.findByRole('group', { name: t('notification.label') });

    act(() => {
      applyEvent(
        queryClient,
        auditEvent({
          entity: 'enquiry',
          summary: { ...enquirySummary(arrived), status: 'closed' },
        }),
      );
    });

    await vi.waitFor(() => {
      expect(
        screen.queryByRole('group', { name: t('notification.label') }),
      ).toBeNull();
    });
  });

  describe('announcement', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(async () => {
      await virtual.stop();
      vi.useRealTimers();
    });

    it('announces the new enquiry as its own phrase, not folded into a list summary', async () => {
      respondEnquiries([]);
      const { queryClient } = renderNotifications();
      await waitForReady();

      await virtual.start({ container: document.body });
      await virtual.clearSpokenPhraseLog();

      const arrived = conversation({ id: 'conv-4', roleName: 'Ops' });
      respondEnquiries([arrived]);
      act(() => {
        applyEvent(
          queryClient,
          auditEvent({ entity: 'enquiry', summary: enquirySummary(arrived) }),
        );
      });
      // Waits for the notification to actually mount — real time keeps
      // flowing under `shouldAdvanceTime`, so this settles independently of
      // the announcer's own delay — before driving that delay forward.
      await screen.findByRole('group', { name: t('notification.label') });
      await vi.advanceTimersByTimeAsync(15_000);

      // One phrase, naming the role that asked — not coalesced with anything
      // else and not a bare count.
      expect(await virtual.spokenPhraseLog()).toEqual([
        `polite: ${t('activity.enquiries.notification', { role: 'Ops' })}`,
      ]);
    });
  });
});
