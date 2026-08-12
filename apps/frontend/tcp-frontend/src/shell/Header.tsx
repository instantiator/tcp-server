import { useState } from 'react';
import {
  Button,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
  type Key,
} from 'react-aria-components';
import { startSignOut } from '../auth/sign-out';
import { useSession } from '../auth/useSession';
import { MembershipsDialog } from '../components/MembershipsDialog/MembershipsDialog';
import { ProfileDialog } from '../components/ProfileDialog/ProfileDialog';
import { t } from '../strings';
import './Header.css';

/**
 * The header on every page except the landing page (ADR-020).
 *
 * The account menu renders only for a signed-in user. An unknown address is
 * reachable signed out, and offering a signed-out visitor "My profile" and
 * "Sign out" would be a lie about their state — one that becomes actively
 * broken the moment 004 makes signing out mean something.
 *
 * `MenuTrigger` is React Aria's menu-button pattern, taken whole: it owns the
 * `aria-haspopup`/`aria-expanded` wiring, arrow-key navigation, type-ahead,
 * Escape, and returning focus to the button on close. Hand-rolling that is how
 * account menus end up unusable by keyboard.
 *
 * No `className` is passed to any React Aria component here — passing one
 * *replaces* the library's default class, and `styles/base.css` styles these by
 * exactly those defaults.
 *
 * **`MenuTrigger` is not moved or replaced for the dialogs.** It already
 * returns focus to the account button when the menu closes, and a dialog
 * mounted after that returns with focus already on that button — which is
 * exactly what makes "focus returns to the opener" work without any code of
 * ours.
 */
export const Header = () => {
  const session = useSession();
  const [openDialog, setOpenDialog] = useState<
    'profile' | 'memberships' | null
  >(null);

  const onAccountAction = (key: Key): void => {
    if (key === 'signOut') {
      void startSignOut();
    } else if (key === 'profile') {
      setOpenDialog('profile');
    } else if (key === 'memberships') {
      setOpenDialog('memberships');
    }
  };

  return (
    <header className="app-header">
      {/* A placeholder until there is a logo (ADR-020). Deliberately not a
          link: this prompt invents no navigation the MVP has not asked for. */}
      <span className="app-header__logo">{t('app.title')}</span>

      {session !== null && (
        <MenuTrigger>
          <Button className="react-aria-Button app-header__account">
            {t('header.account.label')}
          </Button>
          <Popover>
            <Menu onAction={onAccountAction}>
              <MenuItem id="profile">{t('header.account.profile')}</MenuItem>
              <MenuItem id="memberships">
                {t('header.account.memberships')}
              </MenuItem>
              <MenuItem id="signOut">{t('header.account.signOut')}</MenuItem>
            </Menu>
          </Popover>
        </MenuTrigger>
      )}

      {openDialog === 'profile' && (
        <ProfileDialog
          onClose={() => {
            setOpenDialog(null);
          }}
        />
      )}
      {openDialog === 'memberships' && (
        <MembershipsDialog
          onClose={() => {
            setOpenDialog(null);
          }}
        />
      )}
    </header>
  );
};
