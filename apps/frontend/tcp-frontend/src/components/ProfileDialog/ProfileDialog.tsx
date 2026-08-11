import { useAuth } from 'react-oidc-context';
import { Dialog } from '../Dialog/Dialog';
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
 * **Nothing here is written anywhere durable.** No `localStorage`, no
 * `sessionStorage`, no query cache entry, no logging of a claim's value —
 * rendering is the only thing that happens to this data.
 */
export const ProfileDialog = ({ onClose }: ProfileDialogProps) => {
  const { user } = useAuth();
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
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      heading={t('profile.heading')}
    >
      <p className="profile-dialog__field">
        <span className="profile-dialog__field-label">
          {t('profile.name.label')}
        </span>
        {/* A missing claim reads as "not provided", never as the raw `sub` —
            that would look like a name, not an id, to anyone reading it. */}
        {name ?? t('profile.claim.missing')}
      </p>
      <p className="profile-dialog__field">
        <span className="profile-dialog__field-label">
          {t('profile.email.label')}
        </span>
        {email ?? t('profile.claim.missing')}
      </p>
      <p className="profile-dialog__field">
        <span className="profile-dialog__field-label">
          {t('profile.subject.label')}
        </span>
        {sub ?? t('profile.claim.missing')}
      </p>

      {missingBoth && (
        <p className="profile-dialog__claims-note">
          {t('profile.claims.none')}
        </p>
      )}

      <p className="profile-dialog__read-only">{t('profile.readOnly')}</p>
    </Dialog>
  );
};
