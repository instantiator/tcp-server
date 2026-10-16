import { useAuth } from 'react-oidc-context';
import { Link } from 'react-router';
import { useCompanies } from '../../api/hooks';
import { Dialog } from '../Dialog/Dialog';
import { EmptyState } from '../EmptyState/EmptyState';
import { ErrorState } from '../ErrorState/ErrorState';
import { LabelledValue } from '../LabelledValue/LabelledValue';
import { LoadingState } from '../LoadingState/LoadingState';
import { t } from '../../strings';
import './ProfileDialog.css';

export interface ProfileDialogProps {
  readonly onClose: () => void;
}

/**
 * Who the signed-in user is, read straight from their ID token's claims.
 *
 * Claims come from `useAuth()` (`react-oidc-context`) → `user.profile`. That
 * is the same `UserManager` singleton everything else in the application uses
 * (`src/auth/user-manager.ts`, passed to `AuthProvider` in `main.tsx`), and its
 * stored user already has userinfo merged in when `OIDC_LOAD_USER_INFO` is on.
 * The ID token is never decoded by hand here, and `Session`
 * (`src/auth/useSession.ts`) is never extended for this — its own comment
 * records that this dialog reads claims directly, because ADR-023 means there
 * is no `/api/me` to ask instead.
 *
 * **Read-only is a scope decision (ADR-020), not an oversight.** Editing any
 * of this would need user-management endpoints that do not exist yet.
 *
 * Below the claims is the list of companies the user can reach, each a link
 * to open it, with the user's member type in it. `useCompanies({})` — the
 * membership-scoped `GET /api/company`, with no `?all=true` — is the exact
 * call `CompaniesPage` makes, so this reads the query cache that page already
 * filled rather than firing a second request. A plain `<Link>`, matching
 * `CompaniesPage.tsx`, is both the router's own navigation and something every
 * assistive technology already understands.
 *
 * **Nothing here is written anywhere durable.** No `localStorage`, no
 * `sessionStorage`, no query cache entry, no logging of a claim's value —
 * rendering is the only thing that happens to this data.
 */
export const ProfileDialog = ({ onClose }: ProfileDialogProps) => {
  const { user } = useAuth();
  const companies = useCompanies({});
  const profile = user?.profile;

  const name = profile?.name;
  const email = profile?.email;
  const sub = profile?.sub;

  // Naming the actual cause rather than leaving a blank dialog to look like a
  // bug: OIDC_LOAD_USER_INFO defaults to false (004.01) because Zitadel puts
  // `profile` and `email` straight in the ID token, so the default is a
  // userinfo round trip nobody needs to make. A provider that issues a minimal
  // ID token needs the setting turned on instead — a runtime flag, no rebuild.
  const missingBoth = name === undefined && email === undefined;

  return (
    <Dialog onClose={onClose} heading={t('profile.heading')}>
      <LabelledValue label={t('profile.name.label')}>
        {/* A missing claim reads as "not provided", never as the raw `sub` —
            that would look like a name, not an id, to anyone reading it. */}
        {name ?? t('profile.claim.missing')}
      </LabelledValue>
      <LabelledValue label={t('profile.email.label')}>
        {email ?? t('profile.claim.missing')}
      </LabelledValue>
      <LabelledValue label={t('profile.subject.label')}>
        {sub ?? t('profile.claim.missing')}
      </LabelledValue>

      {missingBoth && (
        <p className="profile-dialog__claims-note">
          {t('profile.claims.none')}
        </p>
      )}

      <h3>{t('profile.companies.heading')}</h3>
      {companies.isPending && <LoadingState label={t('memberships.loading')} />}

      {companies.isError && (
        <ErrorState message={t('memberships.error')} channel="memberships" />
      )}

      {companies.data !== undefined &&
        (companies.data.length === 0 ? (
          <EmptyState heading={t('memberships.empty.heading')} headingLevel={4}>
            <p>{t('memberships.empty.body')}</p>
          </EmptyState>
        ) : (
          <>
            <p className="profile-dialog__companies-intro">
              {t('memberships.intro')}
            </p>
            {/*
              Authoritative, not informational (002.05): this is the list of
              companies the user CAN REACH. Anything absent from it answers
              403, not "not listed here" — do not soften this wording back to
              "companies you are listed in".
            */}
            <ul className="profile-dialog__companies">
              {companies.data.map((company) => (
                <li key={company.id} className="profile-dialog__company">
                  <Link
                    to={`/company/${company.id}`}
                    // Closing on click, rather than closing only after the
                    // navigation resolves: the dialog then unmounts, and React
                    // Aria's `ModalOverlay` returns focus to whatever opened
                    // it — the account button in `Header.tsx`, which is in the
                    // header and survives the navigation. That is a deliberate,
                    // present destination for focus, not `document.body`.
                    onClick={onClose}
                  >
                    {company.name}
                  </Link>
                  {company.memberType !== null &&
                    ` — ${t(`memberType.${company.memberType}`)}`}
                </li>
              ))}
            </ul>
          </>
        ))}

      <p className="profile-dialog__read-only">{t('profile.readOnly')}</p>
    </Dialog>
  );
};
