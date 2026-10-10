import { Plus } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import {
  Button,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
  SubmenuTrigger,
  type Key,
} from 'react-aria-components';
import { ANNOUNCE_IMMEDIATE_MS, announce } from '../../announce/announcer';
import { useCompanyRolesList } from '../../api/hooks';
import { t } from '../../strings';
import { Icon, WithTooltip } from '../Icon/Icon';
import { CreateTaskDialog } from '../CreateTaskDialog/CreateTaskDialog';
import { rolesForMenu } from './rolesForMenu';
import { useStartChatAction, type StartChatRole } from './useStartChatAction';
import './AddNewMenu.css';

export interface AddNewMenuProps {
  readonly companyId: string;
  /**
   * The large floating action button (the company page) rather than the
   * small round one (the chat dialog's title bar). Both are icon-only, so
   * `aria-label` carries the name "Add new". Neither needs a
   * `portalContainer`: nothing around them clips an unportalled tooltip.
   */
  readonly fab?: boolean;
}

/**
 * The "Add new" menu: create a task, or start a chat with one of the
 * company's roles (003.01).
 *
 * Follows the account menu's pattern in `shell/Header.tsx` —
 * `MenuTrigger > Button > Popover > Menu`, `onAction`, a dialog mounted from
 * state after the menu — with one addition: `MenuTrigger` is **controlled**
 * (`isOpen`/`onOpenChange`) rather than left to manage its own state, because
 * starting a chat must keep the menu open (to show "Starting chat with…" and
 * disable the other roles) until the attempt settles, then close it itself.
 *
 * **No `className` on any React Aria component** — `styles/base.css` styles
 * these by React Aria's own default class names, and a `className` replaces
 * rather than composes with them.
 *
 * **The roles submenu never renders empty.** A `Menu` with zero items risks
 * not opening at all (untested in jsdom, and nothing here needs the risk): a
 * loading or "no roles" state is one disabled item instead, so the submenu's
 * item collection is never actually empty and `renderEmptyState` is unused.
 *
 * **Not positioned here.** The `add-new` wrapper is a hook for a later stage
 * to place this control; this component only builds the menu.
 */
export const AddNewMenu = ({ companyId, fab = false }: AddNewMenuProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [showCreateTask, setShowCreateTask] = useState(false);
  // The role a chat attempt most recently failed for, so the error paragraph
  // can name it. `useStartChatAction` reports only the error itself — which
  // role it belongs to is known at the call site, here, when `start` is
  // called.
  const [failedRole, setFailedRole] = useState<StartChatRole | null>(null);
  const errorId = useId();

  const rolesQuery = useCompanyRolesList(companyId);
  const sortedRoles = rolesForMenu(rolesQuery.data ?? []);

  const { start, pendingRoleId, error, clearError } = useStartChatAction(
    companyId,
    {
      onStarted: () => {
        setIsOpen(false);
      },
    },
  );

  // A failed attempt leaves `pendingRoleId` cleared but keeps the menu open
  // (React Aria's own behaviour, since selecting the role item didn't close
  // it — `shouldCloseOnSelect` is `false` on the roles menu below). Closing
  // it here is this component's job, same as the success path above.
  useEffect(() => {
    if (error !== null) setIsOpen(false);
  }, [error]);

  const onOpenChange = (open: boolean): void => {
    setIsOpen(open);
    if (!open) setFocusFirstRole(false);
    if (open) {
      clearError();
      setFailedRole(null);
    }
  };

  const onTopAction = (key: Key): void => {
    if (key === 'create-task') setShowCreateTask(true);
  };

  // Sets `failedRole` optimistically, before the attempt has settled: if it
  // fails, `error` becomes non-null on the next render and the paragraph
  // below already has a name to show.
  const onRoleAction = (key: Key): void => {
    const role = sortedRoles.find((candidate) => candidate.id === key);
    if (role === undefined || pendingRoleId !== null) return;
    setFailedRole(role);
    start(role);
    // The focused item's new text is not reliably read out, so say it.
    announce({
      channel: 'add-new',
      change: 'addNew.starting',
      params: { role: role.name },
      throttleMs: ANNOUNCE_IMMEDIATE_MS,
    });
  };

  // Every role but the pending one. Disabling the focused item would drop
  // focus to the menu itself, losing the user's place; a second press on it
  // is ignored above instead.
  // A keyboard user can open the submenu before the roles arrive, landing on
  // "Loading roles…". React Aria leaves focus on the menu container once the
  // roles replace that item, so the menu is remounted to focus the first
  // role. Only when focus was inside it: a hover-opened submenu keeps
  // React Aria's own behaviour.
  const rolesMenu = useRef<HTMLDivElement>(null);
  const rolesLoaded = !rolesQuery.isPending;
  const [focusFirstRole, setFocusFirstRole] = useState(false);
  useEffect(() => {
    if (rolesLoaded && rolesMenu.current?.contains(document.activeElement)) {
      setFocusFirstRole(true);
    }
  }, [rolesLoaded]);

  const disabledRoleKeys =
    pendingRoleId === null
      ? []
      : sortedRoles.map((role) => role.id).filter((id) => id !== pendingRoleId);

  return (
    <div className="add-new">
      <MenuTrigger isOpen={isOpen} onOpenChange={onOpenChange}>
        {/* The floating action button on the company page, or a small round
            + where space is tight (the chat dialog's title bar). */}
        <WithTooltip label={t('addNew.trigger')}>
          <Button
            className={`react-aria-Button tcp-icon-button ${fab ? 'tcp-icon-button--fab' : 'tcp-icon-button--small'} add-new__trigger`}
            aria-label={t('addNew.trigger')}
            aria-describedby={error !== null ? errorId : undefined}
          >
            <Icon icon={Plus} />
          </Button>
        </WithTooltip>
        <Popover>
          <Menu onAction={onTopAction}>
            <MenuItem id="create-task">{t('addNew.createTask')}</MenuItem>
            <SubmenuTrigger>
              <MenuItem id="new-chat">{t('addNew.newChat')}</MenuItem>
              <Popover>
                <Menu
                  ref={rolesMenu}
                  key={focusFirstRole ? 'refocused' : 'initial'}
                  // eslint-disable-next-line jsx-a11y/no-autofocus -- only returns focus the user already had inside this menu (see above)
                  autoFocus={focusFirstRole ? 'first' : undefined}
                  shouldCloseOnSelect={false}
                  disabledKeys={disabledRoleKeys}
                  onAction={onRoleAction}
                >
                  {rolesQuery.isPending ? (
                    // Focusable, not disabled: a keyboard user who opens this
                    // before the roles arrive lands here and hears it, and
                    // focus moves on to a role when they replace it.
                    <MenuItem id="loading-roles">
                      {t('addNew.loadingRoles')}
                    </MenuItem>
                  ) : sortedRoles.length === 0 ? (
                    <MenuItem id="no-roles" isDisabled>
                      {t('addNew.noRoles')}
                    </MenuItem>
                  ) : (
                    sortedRoles.map((role) => (
                      <MenuItem key={role.id} id={role.id}>
                        {pendingRoleId === role.id
                          ? t('addNew.starting', { role: role.name })
                          : role.name}
                      </MenuItem>
                    ))
                  )}
                </Menu>
              </Popover>
            </SubmenuTrigger>
          </Menu>
        </Popover>
      </MenuTrigger>

      {error !== null && (
        <p id={errorId} className="add-new__error">
          {t('addNew.error', { role: failedRole?.name ?? '' })}
        </p>
      )}

      {showCreateTask && (
        <CreateTaskDialog
          companyId={companyId}
          onClose={() => {
            setShowCreateTask(false);
          }}
        />
      )}
    </div>
  );
};
