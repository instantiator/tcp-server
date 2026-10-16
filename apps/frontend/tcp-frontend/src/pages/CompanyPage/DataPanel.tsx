import { Download } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  Header,
  ListBox,
  ListBoxItem,
  ListBoxSection,
  Text,
} from 'react-aria-components';
import { downloadAllRecordTables, useLiveRecordTables } from '../../api/hooks';
import { ErrorState } from '../../components/ErrorState/ErrorState';
import { LoadingState } from '../../components/LoadingState/LoadingState';
import {
  RECORDS_CHANNEL,
  announceRecords,
} from '../../components/RecordSheet/announceRecords';
import { TableView } from '../../components/RecordSheet/TableView';
import { RoundIconButton } from '../../components/RoundIconButton/RoundIconButton';
import { t, tCount } from '../../strings';
import { DocumentsPanel } from './DocumentsPanel';
import './DataPanel.css';

/** What the Data tab shows: a record table (or none yet), or the document links. */
export type DataSelection =
  | { readonly kind: 'tables'; readonly table: string | null }
  | { readonly kind: 'documents' };

/** The menu's item ids. They match the URL hash's path, so a table named "documents" can't clash. */
const DOCUMENTS_KEY = 'documents';
const tableKey = (name: string): string => `tables/${name}`;

export interface DataPanelProps {
  readonly companyId: string;
  readonly companySlug: string;
  /** What is open, from the URL. */
  readonly selected: DataSelection;
  /** Opens a section. The caller puts it in the URL. */
  readonly onSelect: (selection: DataSelection) => void;
}

/**
 * The Data tab (002.00, from 001.03's Tables tab): a menu down the side with
 * a "download all" control, listing the company's record tables under a
 * "Tables" heading and then "Documents", and the chosen one beside it.
 *
 * The menu is a single-select `ListBox`: arrow keys move through it and
 * Enter or Space opens an item. Focus stays on the menu, as in the chat
 * dialog — choosing from a list is not one of ADR-027's four points that
 * move focus — and Tab goes on into the open section. When a table is
 * deleted, focus goes back to the menu (ADR-027's destructive completion).
 */
export const DataPanel = ({
  companyId,
  companySlug,
  selected,
  onSelect,
}: DataPanelProps) => {
  const tables = useLiveRecordTables(companyId);
  const listRef = useRef<HTMLDivElement>(null);
  const table = selected.kind === 'tables' ? selected.table : null;

  const known =
    table !== null && (tables.data ?? []).some(({ name }) => name === table);

  // A table deleted elsewhere leaves the list but stays open, saying so,
  // rather than vanishing from under its reader (001.05, ADR-027). Only a
  // table that was listed is kept: an unknown name in the address is not.
  const [kept, setKept] = useState<string | null>(null);
  if (known && kept !== table) setKept(table);
  const showing = known || (table !== null && table === kept);

  const selectedKey =
    selected.kind === 'documents'
      ? DOCUMENTS_KEY
      : known
        ? tableKey(table)
        : null;

  return (
    <div className="tcp-side-menu">
      <div className="tcp-side-menu__menu">
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
        {tables.isPending && <LoadingState label={t('tables.loading')} />}
        {tables.isError && (
          <ErrorState
            message={t('tables.error')}
            channel={RECORDS_CHANNEL}
            onRetry={() => void tables.refetch()}
          />
        )}
        <ListBox
          ref={listRef}
          className="react-aria-ListBox tcp-side-menu__list"
          aria-label={t('data.menu.label')}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={selectedKey === null ? [] : [selectedKey]}
          onSelectionChange={(keys) => {
            if (keys === 'all') return;
            const [key] = [...keys];
            if (key === DOCUMENTS_KEY) onSelect({ kind: 'documents' });
            else if (typeof key === 'string') {
              onSelect({ kind: 'tables', table: key.slice('tables/'.length) });
            }
          }}
        >
          <ListBoxSection className="react-aria-ListBoxSection">
            <Header className="react-aria-Header tcp-side-menu__header">
              {t('data.menu.tables')}
            </Header>
            {(tables.data ?? []).map(({ name, records }) => (
              <ListBoxItem
                key={name}
                id={tableKey(name)}
                textValue={name}
                className="react-aria-ListBoxItem data-panel__item"
              >
                <Text slot="label">{name}</Text>
                <Text slot="description" className="data-panel__count">
                  {tCount('records.count', records)}
                </Text>
              </ListBoxItem>
            ))}
          </ListBoxSection>
          <ListBoxItem
            id={DOCUMENTS_KEY}
            className="react-aria-ListBoxItem data-panel__item"
          >
            {t('data.menu.documents')}
          </ListBoxItem>
        </ListBox>
      </div>
      <div>
        {selected.kind === 'documents' ? (
          <DocumentsPanel companyId={companyId} companySlug={companySlug} />
        ) : showing ? (
          <TableView
            key={table}
            companyId={companyId}
            companySlug={companySlug}
            table={table}
            titleLevel={2}
            onDropped={() => {
              onSelect({ kind: 'tables', table: null });
              listRef.current?.focus();
            }}
          />
        ) : (
          tables.isSuccess && (
            <p className="data-panel__hint">
              {t(tables.data.length === 0 ? 'tables.empty' : 'tables.choose')}
            </p>
          )
        )}
      </div>
    </div>
  );
};
