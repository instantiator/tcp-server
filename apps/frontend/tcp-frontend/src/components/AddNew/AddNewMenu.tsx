import { useEffect, useId, useState } from 'react';
import {
  Button,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
  SubmenuTrigger,
  type Key,
} from 'react-aria-components';
import { useCompanyRolesList } from '../../api/hooks';
import { t } from '../../strings';
import { CreateTaskDialog } from '../CreateTaskDialog/CreateTaskDialog';
import { rolesForMenu } from './rolesForMenu';
import { useStartChatAction, type StartChatRole } from './useStartChatAction';
import './AddNewMenu.css';

export interface AddNewMenuProps {
  readonly companyId: string;
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
export const AddNewMenu = ({ companyId }: AddNewMenuProps) => {
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
    if (role === undefined) return;
    setFailedRole(role);
    start(role);
  };

  const disabledRoleKeys =
    pendingRoleId === null ? [] : sortedRoles.map((role) => role.id);

  return (
    <div className="add-new">
      <MenuTrigger isOpen={isOpen} onOpenChange={onOpenChange}>
        <Button
          className="react-aria-Button add-new__trigger"
          aria-describedby={error !== null ? errorId : undefined}
        >
          {t('addNew.trigger')}
        </Button>
        <Popover>
          <Menu onAction={onTopAction}>
            <MenuItem id="create-task">{t('addNew.createTask')}</MenuItem>
            <SubmenuTrigger>
              <MenuItem id="new-chat">{t('addNew.newChat')}</MenuItem>
              <Popover>
                <Menu
                  shouldCloseOnSelect={false}
                  disabledKeys={disabledRoleKeys}
                  onAction={onRoleAction}
                >
                  {rolesQuery.isPending ? (
                    <MenuItem id="loading-roles" isDisabled>
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
