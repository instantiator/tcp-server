import { ArrowDown, ArrowUp, PanelRightOpen, Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  Button,
  Cell,
  CheckboxButton,
  CheckboxField,
  Column,
  Row,
  Table,
  TableBody,
  TableHeader,
  type Selection,
  type SortDescriptor,
} from 'react-aria-components';
import { announce } from '../../../announce/announcer';
import { ApiError } from '../../../api/errors';
import {
  useCompanyRolesList,
  useDeleteRole,
  useLiveCompanyState,
} from '../../../api/hooks';
import { ConfirmDialog } from '../../../components/Dialog/ConfirmDialog';
import { EmptyState } from '../../../components/EmptyState/EmptyState';
import { ErrorState } from '../../../components/ErrorState/ErrorState';
import { TextField } from '../../../components/Field/TextField';
import { LoadingState } from '../../../components/LoadingState/LoadingState';
import { RoundIconButton } from '../../../components/RoundIconButton/RoundIconButton';
import { sortRows } from '../../../components/Table/sortRows';
import { t, tCount } from '../../../strings';
import { RoleDialog } from './RoleDialog';
import './RolesAdmin.css';

/** The announcer channel for role changes; this component is its one writer. */
const ROLES_CHANNEL = 'roles';

/** Which role the dialog shows: a new one, or an existing one by id. */
type OpenRole =
  { readonly kind: 'new' } | { readonly kind: 'edit'; readonly id: string };

export interface RolesAdminProps {
  readonly companyId: string;
}

/**
 * Admin → Roles (002.00): the company's roles as a table that sorts by name
 * or slug, filters by name, and selects rows for deleting. Add role and each
 * row's Open button (or its name) open the role dialog.
 *
 * Deleting asks first, through `ConfirmDialog`, and names every role going.
 * When the company's default planner is among them it says what that breaks:
 * tasks without their own planner won't start. A role's knowledge goes with
 * it, on the server (`KnowledgeService.deleteRole`).
 *
 * After a delete, focus goes to the table, or to Add role when no rows are
 * left (ADR-027's destructive completion), and the change is announced.
 */
export const RolesAdmin = ({ companyId }: RolesAdminProps) => {
  const roles = useCompanyRolesList(companyId);
  const company = useLiveCompanyState(companyId);
  // `GET /api/company/{id}` answers a JSON `null` for a company the caller
  // can't see, so read the planner through optional chaining.
  const plannerId = company.data?.plannerRoleId ?? null;
  const deleteRole = useDeleteRole();

  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<SortDescriptor>({
    column: 'name',
    direction: 'ascending',
  });
  const [selected, setSelected] = useState<Selection>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenRole | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const needle = filter.trim().toLowerCase();
  const rows = sortRows(
    (roles.data ?? []).filter((role) =>
      role.name.toLowerCase().includes(needle),
    ),
    sort,
    (role, column) => (column === 'slug' ? role.slug : role.name),
  );
  const chosen =
    selected === 'all' ? rows : rows.filter((role) => selected.has(role.id));
  const planner = chosen.find((role) => role.id === plannerId);

  const confirmDelete = async (): Promise<void> => {
    setConfirming(false);
    const results = await Promise.allSettled(
      chosen.map((role) => deleteRole.mutateAsync(role.id)),
    );
    const deleted = results.filter((r) => r.status === 'fulfilled').length;
    const refused = results.find((r) => r.status === 'rejected');
    setSelected(new Set());
    setFailure(
      refused === undefined
        ? null
        : t('admin.roles.deleteFailed', {
            message:
              refused.reason instanceof ApiError
                ? refused.reason.message
                : t('records.error.generic'),
          }),
    );
    if (deleted > 0) {
      announce({
        channel: ROLES_CHANNEL,
        change: 'admin.roles.announce.deleted',
        params: { count: deleted },
      });
    }
    // The deleted rows have gone from under the reader: put focus somewhere
    // that still exists — the table, or the heading once no rows are left.
    if (rows.length > deleted) tableRef.current?.focus();
    else headingRef.current?.focus();
  };

  return (
    <section aria-labelledby="roles-admin-heading" className="roles-admin">
      <h2 id="roles-admin-heading" ref={headingRef} tabIndex={-1}>
        {t('admin.roles.heading')}
      </h2>
      <div className="roles-admin__toolbar">
        <RoundIconButton
          icon={Plus}
          label={t('admin.roles.add')}
          onPress={() => setOpen({ kind: 'new' })}
        />
        <RoundIconButton
          icon={Trash2}
          label={
            chosen.length === 0
              ? t('admin.roles.deleteNone')
              : tCount('admin.roles.delete', chosen.length)
          }
          isDisabled={chosen.length === 0}
          isPending={deleteRole.isPending}
          onPress={() => setConfirming(true)}
        />
        <TextField
          label={t('admin.roles.filter')}
          value={filter}
          onChange={setFilter}
        />
      </div>
      {failure !== null && (
        <p className="tcp-field__error" role="alert">
          {failure}
        </p>
      )}
      {roles.isPending ? (
        <LoadingState label={t('admin.roles.loading')} />
      ) : roles.isError ? (
        <ErrorState
          message={t('admin.roles.error')}
          channel={ROLES_CHANNEL}
          onRetry={() => void roles.refetch()}
        />
      ) : roles.data.length === 0 ? (
        <EmptyState heading={t('admin.roles.heading')} headingLevel={3}>
          <p>{t('admin.roles.empty')}</p>
        </EmptyState>
      ) : (
        <Table
          ref={tableRef}
          aria-labelledby="roles-admin-heading"
          className="react-aria-Table tcp-table"
          selectionMode="multiple"
          selectedKeys={selected}
          onSelectionChange={setSelected}
          sortDescriptor={sort}
          onSortChange={setSort}
        >
          <TableHeader className="react-aria-TableHeader">
            <Column className="react-aria-Column" width={40}>
              <CheckboxField slot="selection">
                <CheckboxButton className="react-aria-CheckboxButton" />
              </CheckboxField>
            </Column>
            <SortableColumn
              id="name"
              isRowHeader
              label={t('admin.roles.column.name')}
            />
            <SortableColumn id="slug" label={t('admin.roles.column.slug')} />
            <Column className="react-aria-Column">
              {t('admin.roles.column.description')}
            </Column>
            <Column className="react-aria-Column">
              {t('admin.roles.column.planner')}
            </Column>
            <Column className="react-aria-Column">
              {t('admin.roles.column.actions')}
            </Column>
          </TableHeader>
          <TableBody
            className="react-aria-TableBody"
            renderEmptyState={() => (
              <p>{t('admin.roles.noMatch', { filter: filter.trim() })}</p>
            )}
          >
            {rows.map((role) => (
              <Row key={role.id} id={role.id} className="react-aria-Row">
                <Cell className="react-aria-Cell">
                  <CheckboxField slot="selection">
                    <CheckboxButton className="react-aria-CheckboxButton" />
                  </CheckboxField>
                </Cell>
                <Cell className="react-aria-Cell">
                  <Button
                    className="react-aria-Button roles-admin__name"
                    onPress={() => setOpen({ kind: 'edit', id: role.id })}
                  >
                    {role.name}
                  </Button>
                </Cell>
                <Cell className="react-aria-Cell">{role.slug}</Cell>
                <Cell className="react-aria-Cell roles-admin__description">
                  {role.description}
                </Cell>
                <Cell className="react-aria-Cell">
                  {role.id === plannerId && t('admin.roles.planner')}
                </Cell>
                <Cell className="react-aria-Cell">
                  <RoundIconButton
                    icon={PanelRightOpen}
                    label={t('admin.roles.open', { name: role.name })}
                    onPress={() => setOpen({ kind: 'edit', id: role.id })}
                  />
                </Cell>
              </Row>
            ))}
          </TableBody>
        </Table>
      )}
      <ConfirmDialog
        isOpen={confirming}
        heading={tCount('admin.roles.deleteHeading', chosen.length)}
        message={[
          t('admin.roles.deleteMessage', {
            names: chosen.map((role) => role.name).join(', '),
          }),
          planner === undefined
            ? ''
            : t('admin.roles.deletePlanner', { name: planner.name }),
        ]
          .filter(Boolean)
          .join(' ')}
        confirmLabel={t('admin.roles.deleteConfirm')}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setConfirming(false)}
      />
      {open !== null && (
        <RoleDialog
          companyId={companyId}
          roleId={open.kind === 'edit' ? open.id : null}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
};

/**
 * A column that sorts on press. Its arrow shows the direction and is hidden
 * from assistive technology: React Aria puts `aria-sort` on the header,
 * which says the same thing in words.
 */
const SortableColumn = ({
  id,
  label,
  isRowHeader,
}: {
  readonly id: string;
  readonly label: string;
  readonly isRowHeader?: boolean;
}) => (
  <Column
    id={id}
    isRowHeader={isRowHeader}
    allowsSorting
    className="react-aria-Column"
  >
    {({ sortDirection }) => (
      <span className="roles-admin__sort">
        {label}
        {sortDirection === 'ascending' && (
          <ArrowUp aria-hidden="true" className="tcp-icon" />
        )}
        {sortDirection === 'descending' && (
          <ArrowDown aria-hidden="true" className="tcp-icon" />
        )}
      </span>
    )}
  </Column>
);
