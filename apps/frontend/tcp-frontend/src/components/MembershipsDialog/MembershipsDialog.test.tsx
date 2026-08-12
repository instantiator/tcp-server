import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Button } from 'react-aria-components';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import {
  fetchMock,
  installFetchMock,
  respondWithJson,
} from '../../test-support/fetch-mock';
import { MembershipsDialog } from './MembershipsDialog';

/** A `CompanyListItemDto`, filled in with the fields this dialog never reads. */
const company = (id: string, name: string) => ({
  id,
  slug: id,
  name,
  description: '',
  stats: {
    activeAgents: 0,
    tasksByStatus: {
      ready: 0,
      planning: 0,
      'in-progress': 0,
      finalising: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    },
    openEnquiries: 0,
  },
});

/** Reads the current route, the way a click on one of the dialog's links would change it. */
const LocationProbe = () => {
  const location = useLocation();
  return <p data-testid="location">{location.pathname}</p>;
};

/**
 * A real, keyboard-reachable control that opens the dialog — the account
 * button's stand-in — so React Aria's dialog has something to return focus to
 * on close, matching `TaskDialog.test.tsx`'s pattern.
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
        Open memberships
      </Button>
      <LocationProbe />
      {open && (
        <MembershipsDialog
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </>
  );
};

const renderMembershipsDialog = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={['/']}>
        <Opener />
      </MemoryRouter>
    </QueryClientProvider>,
  );

const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: 'Open memberships' }));
};

describe('MembershipsDialog', () => {
  beforeEach(() => {
    installFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists the user's companies as links named by company", async () => {
    respondWithJson(200, [company('company-1', 'Acme Corporation')]);
    const user = userEvent.setup();
    renderMembershipsDialog();

    await openDialog(user);

    expect(
      await screen.findByRole('link', { name: 'Acme Corporation' }),
    ).toHaveAttribute('href', '/company/company-1');
  });

  it('sends no ?all parameter — this reads the membership scope, not the administrator one', async () => {
    respondWithJson(200, [company('company-1', 'Acme Corporation')]);
    const user = userEvent.setup();
    renderMembershipsDialog();

    await openDialog(user);
    await screen.findByRole('link', { name: 'Acme Corporation' });

    const url =
      fetchMock.mock.calls[0]?.[0] instanceof Request
        ? fetchMock.mock.calls[0][0].url
        : String(fetchMock.mock.calls[0]?.[0]);
    expect(url).not.toContain('all');
  });

  it('navigates and closes the dialog when a company is chosen', async () => {
    respondWithJson(200, [company('company-1', 'Acme Corporation')]);
    const user = userEvent.setup();
    renderMembershipsDialog();

    await openDialog(user);
    await user.click(
      await screen.findByRole('link', { name: 'Acme Corporation' }),
    );

    expect(screen.getByTestId('location')).toHaveTextContent(
      '/company/company-1',
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('returns focus to the account button, not the page body, after navigating', async () => {
    respondWithJson(200, [company('company-1', 'Acme Corporation')]);
    const user = userEvent.setup();
    renderMembershipsDialog();

    const opener = screen.getByRole('button', { name: 'Open memberships' });
    await openDialog(user);
    await user.click(
      await screen.findByRole('link', { name: 'Acme Corporation' }),
    );

    // The dialog unmounting is what returns focus: React Aria's
    // `ModalOverlay` restores it to whatever opened the dialog, which is the
    // account button — a present, deliberate destination, not `document.body`.
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
  });

  it('shows the empty state, naming what it means to reach nothing, when there are no companies', async () => {
    respondWithJson(200, []);
    const user = userEvent.setup();
    renderMembershipsDialog();

    await openDialog(user);

    expect(
      await screen.findByRole('heading', {
        name: t('memberships.empty.heading'),
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(t('memberships.empty.body'))).toBeInTheDocument();
  });

  it('shows a loading state while the companies are loading', async () => {
    fetchMock.mockReturnValueOnce(new Promise(() => undefined));
    const user = userEvent.setup();
    renderMembershipsDialog();

    await openDialog(user);

    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('shows a failure message when the companies fail to load', async () => {
    respondWithJson(500, { statusCode: 500, message: 'boom' });
    const user = userEvent.setup();
    renderMembershipsDialog();

    await openDialog(user);

    expect(await screen.findByText(t('memberships.error'))).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    respondWithJson(200, [company('company-1', 'Acme Corporation')]);
    const user = userEvent.setup();
    renderMembershipsDialog();

    await openDialog(user);
    await screen.findByRole('link', { name: 'Acme Corporation' });

    // document.body, not container: React Aria's `Modal` portals the dialog
    // out of the render container.
    await expectNoA11yViolations(document.body);
  });
});
