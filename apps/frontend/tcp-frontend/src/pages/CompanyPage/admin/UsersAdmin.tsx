import { ArrowDown, ArrowUp } from 'lucide-react';
import { useState } from 'react';
import {
  Cell,
  Column,
  Row,
  Table,
  TableBody,
  TableHeader,
  type SortDescriptor,
} from 'react-aria-components';
import { useCompanyUsers } from '../../../api/hooks';
import { EmptyState } from '../../../components/EmptyState/EmptyState';
import { ErrorState } from '../../../components/ErrorState/ErrorState';
import { TextField } from '../../../components/Field/TextField';
import { LoadingState } from '../../../components/LoadingState/LoadingState';
import { sortRows } from '../../../components/Table/sortRows';
import { t } from '../../../strings';
import './UsersAdmin.css';

/** The announcer channel for load failures here. */
const USERS_CHANNEL = 'users';

export interface UsersAdminProps {
  readonly companyId: string;
}

/**
 * Admin → Users (002.00): the company's members as a read-only table that
 * sorts by name or member type and filters by name. The note above it is
 * always shown: membership is the whole of access control, so being listed
 * here grants everything in the company.
 */
export const UsersAdmin = ({ companyId }: UsersAdminProps) => {
  const users = useCompanyUsers(companyId);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<SortDescriptor>({
    column: 'name',
    direction: 'ascending',
  });

  // A member with no name is found, and sorted, by their sign-in identifier.
  const shownName = (user: { name: string | null; identifier: string }) =>
    user.name ?? user.identifier;

  const needle = filter.trim().toLowerCase();
  const rows = sortRows(
    (users.data ?? []).filter((user) =>
      shownName(user).toLowerCase().includes(needle),
    ),
    sort,
    (user, column) =>
      column === 'memberType' ? user.memberType : shownName(user),
  );

  return (
    <section aria-labelledby="users-admin-heading" className="users-admin">
      <h2 id="users-admin-heading">{t('admin.users.heading')}</h2>
      <p>{t('admin.users.note')}</p>
      <TextField
        label={t('admin.users.filter')}
        value={filter}
        onChange={setFilter}
      />
      {users.isPending ? (
        <LoadingState label={t('admin.users.loading')} />
      ) : users.isError ? (
        <ErrorState
          message={t('admin.users.error')}
          channel={USERS_CHANNEL}
          onRetry={() => void users.refetch()}
        />
      ) : users.data.length === 0 ? (
        <EmptyState heading={t('admin.users.heading')} headingLevel={3}>
          <p>{t('admin.users.empty')}</p>
        </EmptyState>
      ) : (
        <Table
          aria-labelledby="users-admin-heading"
          className="react-aria-Table tcp-table"
          sortDescriptor={sort}
          onSortChange={setSort}
        >
          <TableHeader className="react-aria-TableHeader">
            <SortableColumn
              id="name"
              isRowHeader
              label={t('admin.users.column.name')}
            />
            <Column className="react-aria-Column">
              {t('admin.users.column.identifier')}
            </Column>
            <SortableColumn
              id="memberType"
              label={t('admin.users.column.memberType')}
            />
            <Column className="react-aria-Column">
              {t('admin.users.column.roles')}
            </Column>
          </TableHeader>
          <TableBody
            className="react-aria-TableBody"
            renderEmptyState={() => (
              <p>{t('admin.users.noMatch', { filter: filter.trim() })}</p>
            )}
          >
            {rows.map((user) => (
              <Row
                key={user.identifier}
                id={user.identifier}
                className="react-aria-Row"
              >
                <Cell className="react-aria-Cell">
                  {user.name ?? t('admin.users.noName')}
                </Cell>
                <Cell className="react-aria-Cell">{user.identifier}</Cell>
                <Cell className="react-aria-Cell">
                  {t(`memberType.${user.memberType}`)}
                </Cell>
                <Cell className="react-aria-Cell">{user.roles.join(', ')}</Cell>
              </Row>
            ))}
          </TableBody>
        </Table>
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
      <span className="users-admin__sort">
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
