import { User } from 'lucide-react';
import { useState } from 'react';
import {
  Button,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
  type Key,
} from 'react-aria-components';
import { useMatch } from 'react-router';
import { useLiveCompanyState } from '../api/hooks';
import { startSignOut } from '../auth/sign-out';
import { useSession } from '../auth/useSession';
import { Icon, WithTooltip } from '../components/Icon/Icon';
import { MembershipsDialog } from '../components/MembershipsDialog/MembershipsDialog';
import { ProfileDialog } from '../components/ProfileDialog/ProfileDialog';
import { t } from '../strings';
import './Header.css';

/**
 * The header's title while on a company route: `app.titleWithCompany` once
 * the name has loaded, falling back to the plain `app.title` while the
 * request is in flight, has failed, or answered with no company at all (an
 * id the caller cannot see loads as a successful `null`, not an error — see
 * `CompanyPage`). A separate component because hooks cannot be called
 * conditionally: `Header` renders this only when the route matches, rather
 * than calling `useLiveCompanyState` with a possibly-absent id.
 */
const CompanyTitle = ({ companyId }: { readonly companyId: string }) => {
  const { data, isPending, isError } = useLiveCompanyState(companyId);
  const name = isPending || isError ? undefined : (data?.name ?? undefined);
  return (
    <span className="app-header__logo">
      {name === undefined
        ? t('app.title')
        : t('app.titleWithCompany', { company: name })}
    </span>
  );
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
 * The account trigger passes `className` to `Button` to add the icon-button
 * look — always *alongside* `react-aria-Button`, since a `className` on a
 * React Aria component *replaces* its default class rather than adding to it,
 * and `styles/base.css` styles these components by exactly those defaults.
 *
 * `WithTooltip` wraps only the `Button`, not the whole `MenuTrigger`: React
 * Aria wires the trigger button and the popover through context rather than
 * by position, so nesting the button inside another component's children
 * does not stop `MenuTrigger` from finding it — the menu still opens by
 * pointer and keyboard, and `WithTooltip`'s own `TooltipTrigger` adds hover
 * and focus behaviour on top without touching that wiring.
 *
 * **`MenuTrigger` is not moved or replaced for the dialogs.** It already
 * returns focus to the account button when the menu closes, and a dialog
 * mounted after that returns with focus already on that button — which is
 * exactly what makes "focus returns to the opener" work without any code of
 * ours.
 */
export const Header = () => {
  const session = useSession();
  const companyId = useMatch('/company/:companyId/*')?.params.companyId;
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

  const accountLabel = t('header.account.label');

  return (
    <header className="app-header">
      {/* A placeholder until there is a logo (ADR-020). Deliberately not a
          link: this prompt invents no navigation the MVP has not asked for.
          Off a company route the plain title is static; on one, `CompanyTitle`
          takes over once the company's name has loaded. */}
      {companyId === undefined ? (
        <span className="app-header__logo">{t('app.title')}</span>
      ) : (
        <CompanyTitle companyId={companyId} />
      )}

      {session !== null && (
        <MenuTrigger>
          <WithTooltip label={accountLabel}>
            <Button
              className="react-aria-Button tcp-icon-button app-header__account"
              aria-label={accountLabel}
            >
              <Icon icon={User} />
            </Button>
          </WithTooltip>
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
