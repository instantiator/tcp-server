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
import { t } from '../strings';
import './Header.css';

/**
 * Handles a choice from the account menu.
 *
 * Two of the three destinations do not exist yet: the profile and memberships
 * dialogs are 008.06, and reach the user through the dialog framework 008.01
 * builds. Sign-out goes through the seam in `auth/sign-out.ts`, which 004.03
 * replaces. The point of this prompt is the shell, not the destinations, so the
 * two dialog items are inert — the menu itself is what this prompt has to get
 * right, and it is asserted by role, name and keyboard operation either way.
 */
const onAccountAction = (key: Key): void => {
  if (key === 'signOut') {
    startSignOut();
  }
};

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
 */
export const Header = () => {
  const session = useSession();

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
    </header>
  );
};
