import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render as rtlRender, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserProfile } from 'oidc-client-ts';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import {
  installFetchMock,
  requestedUrls,
  respondByRoute,
} from '../../test-support/fetch-mock';
import { ProfileDialog } from './ProfileDialog';

// `useAuth()` is the one seam this dialog reads through — see the component's
// own comment on why the real `UserManager` singleton is not stood up here:
// the claims it exposes are the whole of what is under test, not the OIDC
// exchange that produced them.
let profile: UserProfile | undefined;

vi.mock('react-oidc-context', () => ({
  useAuth: () => ({ user: profile === undefined ? null : { profile } }),
}));

const FULL_PROFILE: UserProfile = {
  sub: 'user-123',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  iss: 'https://idp.example.com',
  aud: 'test-web-client',
  exp: 0,
  iat: 0,
};

const SUB_ONLY_PROFILE: UserProfile = {
  sub: 'user-123',
  iss: 'https://idp.example.com',
  aud: 'test-web-client',
  exp: 0,
  iat: 0,
};

const COMPANIES_ROUTE = /\/api\/company$/;

/** Answers the company list with the given status and body. */
const respondCompanies = (body: unknown, status = 200): void =>
  respondByRoute([[COMPANIES_ROUTE, { status, body }]]);

/** The dialog reads the company list, so it needs a query client and a router. */
const render = (ui: ReactElement) =>
  rtlRender(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

/** A `CompanyListItemDto`, filled in with the fields this dialog never reads. */
const company = (
  id: string,
  name: string,
  memberType: 'creator' | 'owner' | 'member' | null,
) => ({
  id,
  slug: id,
  name,
  description: '',
  memberType,
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

describe('ProfileDialog', () => {
  beforeEach(() => {
    profile = FULL_PROFILE;
    installFetchMock();
    respondByRoute([[COMPANIES_ROUTE, { body: [] }]]);
  });

  it("renders the signed-in user's name, email and subject", () => {
    render(<ProfileDialog onClose={() => {}} />);

    const nameRow = screen.getByText(t('profile.name.label')).closest('p');
    const emailRow = screen.getByText(t('profile.email.label')).closest('p');
    const subjectRow = screen
      .getByText(t('profile.subject.label'))
      .closest('p');

    expect(nameRow).toHaveTextContent('Ada Lovelace');
    expect(emailRow).toHaveTextContent('ada@example.com');
    expect(subjectRow).toHaveTextContent('user-123');
  });

  describe('when the provider sent only a subject', () => {
    beforeEach(() => {
      profile = SUB_ONLY_PROFILE;
    });

    it('shows the missing-claim fallback for both name and email, never the raw subject', () => {
      render(<ProfileDialog onClose={() => {}} />);

      const nameRow = screen.getByText(t('profile.name.label')).closest('p');
      const emailRow = screen.getByText(t('profile.email.label')).closest('p');

      expect(nameRow).toHaveTextContent(t('profile.claim.missing'));
      expect(nameRow).not.toHaveTextContent('user-123');
      expect(emailRow).toHaveTextContent(t('profile.claim.missing'));
      expect(emailRow).not.toHaveTextContent('user-123');

      // The subject row itself still shows the real subject — only the name
      // and email rows fall back.
      const subjectRow = screen
        .getByText(t('profile.subject.label'))
        .closest('p');
      expect(subjectRow).toHaveTextContent('user-123');
    });

    it('explains the OIDC_LOAD_USER_INFO cause when both claims are missing', () => {
      render(<ProfileDialog onClose={() => {}} />);

      expect(screen.getByText(t('profile.claims.none'))).toBeInTheDocument();
      expect(screen.getByText(/OIDC_LOAD_USER_INFO/)).toBeInTheDocument();
    });
  });

  it('does not show the missing-claims note when only one claim is present', () => {
    profile = { ...SUB_ONLY_PROFILE, name: 'Ada Lovelace' };
    render(<ProfileDialog onClose={() => {}} />);

    expect(screen.queryByText(t('profile.claims.none'))).toBeNull();
  });

  it('has no inputs, no disabled controls, and no button beyond Close', () => {
    render(<ProfileDialog onClose={() => {}} />);

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.body.querySelectorAll('[disabled]')).toHaveLength(0);
    expect(
      document.body.querySelectorAll('[aria-disabled="true"]'),
    ).toHaveLength(0);

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName(t('dialog.close'));
  });

  it('has no accessibility violations', async () => {
    render(<ProfileDialog onClose={() => {}} />);

    // document.body, not container: React Aria's `Modal` portals the dialog
    // out of the render container.
    await expectNoA11yViolations(document.body);
  });

  describe('the companies section', () => {
    it('lists the reachable companies as links, with the member type when known', async () => {
      respondCompanies([
        company('c1', 'Acme Corporation', 'creator'),
        company('c2', 'Globex', null),
      ]);
      render(<ProfileDialog onClose={() => {}} />);

      expect(
        screen.getByRole('heading', { name: t('profile.companies.heading') }),
      ).toBeInTheDocument();
      expect(
        await screen.findByRole('link', { name: 'Acme Corporation' }),
      ).toHaveAttribute('href', '/company/c1');
      expect(screen.getByRole('link', { name: 'Globex' })).toHaveAttribute(
        'href',
        '/company/c2',
      );
      const items = screen.getAllByRole('listitem');
      expect(items[0]).toHaveTextContent(
        `Acme Corporation — ${t('memberType.creator')}`,
      );
      expect(items[1]).toHaveTextContent(/^Globex$/);
      await expectNoA11yViolations(document.body);
    });

    it('sends no ?all parameter: this is the membership scope, not the administrator one', async () => {
      respondCompanies([company('c1', 'Acme Corporation', 'member')]);
      render(<ProfileDialog onClose={() => {}} />);
      await screen.findByRole('link', { name: 'Acme Corporation' });

      expect(requestedUrls()[0]).not.toContain('all');
    });

    it('says what it means to reach nothing when there are no companies', async () => {
      render(<ProfileDialog onClose={() => {}} />);

      expect(
        await screen.findByText(t('memberships.empty.body')),
      ).toBeInTheDocument();
    });

    it('shows a failure message when the companies fail to load', async () => {
      respondCompanies({ statusCode: 500, message: 'boom' }, 500);
      render(<ProfileDialog onClose={() => {}} />);

      expect(
        await screen.findByText(t('memberships.error')),
      ).toBeInTheDocument();
    });

    it('closes the dialog when a company is chosen', async () => {
      respondCompanies([company('c1', 'Acme Corporation', 'owner')]);
      const onClose = vi.fn();
      const user = userEvent.setup();
      render(<ProfileDialog onClose={onClose} />);

      await user.click(
        await screen.findByRole('link', { name: 'Acme Corporation' }),
      );

      expect(onClose).toHaveBeenCalledOnce();
    });
  });
});
