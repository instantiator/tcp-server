import { render, screen } from '@testing-library/react';
import type { UserProfile } from 'oidc-client-ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
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

describe('ProfileDialog', () => {
  beforeEach(() => {
    profile = FULL_PROFILE;
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
});
