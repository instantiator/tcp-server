import { Download } from 'lucide-react';
import { useRef } from 'react';
import { ListBox, ListBoxItem, Text } from 'react-aria-components';
import { downloadAllRecordTables, useRecordTables } from '../../api/hooks';
import { ErrorState } from '../../components/ErrorState/ErrorState';
import { LoadingState } from '../../components/LoadingState/LoadingState';
import {
  RECORDS_CHANNEL,
  announceRecords,
} from '../../components/RecordSheet/announceRecords';
import { TableView } from '../../components/RecordSheet/TableView';
import { RoundIconButton } from '../../components/RoundIconButton/RoundIconButton';
import { t, tCount } from '../../strings';
import './TablesPanel.css';

export interface TablesPanelProps {
  readonly companyId: string;
  readonly companySlug: string;
  /** The open table, from the URL, or `null`. */
  readonly selected: string | null;
  /** Opens a table, or none. The caller puts it in the URL. */
  readonly onSelect: (table: string | null) => void;
}

/**
 * The company's record tables (001.03): a list of tables down the side with
 * a "download all" control, and the chosen table's sheet beside it — the
 * chat dialog's list-and-view layout, stacked on a narrow screen.
 *
 * The list is a single-select `ListBox`: arrow keys move through the tables
 * and Enter or Space opens one. Focus stays on the list, as in the chat
 * dialog — choosing from a list is not one of ADR-027's four points that
 * move focus — and Tab goes on into the open table. When a table is deleted,
 * focus goes back to the list (ADR-027's destructive completion).
 */
export const TablesPanel = ({
  companyId,
  companySlug,
  selected,
  onSelect,
}: TablesPanelProps) => {
  const tables = useRecordTables(companyId);
  const listRef = useRef<HTMLDivElement>(null);

  const known =
    selected !== null &&
    (tables.data ?? []).some((table) => table.name === selected);

  return (
    <div className="tables-panel">
      <div className="tables-panel__menu">
        <RoundIconButton
          icon={Download}
          label={t('records.downloadAll')}
          isDisabled={(tables.data ?? []).length === 0}
          onPress={() =>
            void downloadAllRecordTables(companyId, companySlug).catch(() =>
              announceRecords('records.downloadFailed'),
            )
          }
        />
        {tables.isPending ? (
          <LoadingState label={t('tables.loading')} />
        ) : tables.isError ? (
          <ErrorState
            message={t('tables.error')}
            channel={RECORDS_CHANNEL}
            onRetry={() => void tables.refetch()}
          />
        ) : (
          <ListBox
            ref={listRef}
            className="react-aria-ListBox tables-panel__list"
            aria-label={t('tables.list.label')}
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={known ? [selected] : []}
            onSelectionChange={(keys) => {
              if (keys === 'all') return;
              const [key] = [...keys];
              if (typeof key === 'string') onSelect(key);
            }}
            renderEmptyState={() => (
              <p className="tables-panel__empty">{t('tables.empty')}</p>
            )}
          >
            {(tables.data ?? []).map((table) => (
              <ListBoxItem
                key={table.name}
                id={table.name}
                textValue={table.name}
                className="react-aria-ListBoxItem tables-panel__item"
              >
                <Text slot="label">{table.name}</Text>
                <Text slot="description" className="tables-panel__count">
                  {tCount('records.count', table.records)}
                </Text>
              </ListBoxItem>
            ))}
          </ListBox>
        )}
      </div>
      <div className="tables-panel__main">
        {known ? (
          <TableView
            key={selected}
            companyId={companyId}
            companySlug={companySlug}
            table={selected}
            titleLevel={2}
            onDropped={() => {
              onSelect(null);
              listRef.current?.focus();
            }}
          />
        ) : (
          (tables.data ?? []).length > 0 && (
            <p className="tables-panel__hint">{t('tables.choose')}</p>
          )
        )}
      </div>
    </div>
  );
};
