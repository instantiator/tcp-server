import { Download, Trash2 } from 'lucide-react';
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type SubmitEvent,
} from 'react';
import { Button } from 'react-aria-components';
import { ApiError } from '../../api/errors';
import type { RowChanges } from '../../api/hooks';
import type { RecordSearchResult, TimedRecord } from '../../api/dtos';
import {
  downloadRecordSelection,
  useDeleteRecordsAcross,
  useLiveRecordSearchChanges,
  useRecordSearch,
  useReloadRecordSearch,
  useUpdateRecord,
  type LiveRecordSearchChanges,
} from '../../api/hooks';
import { ErrorState } from '../../components/ErrorState/ErrorState';
import { TextField } from '../../components/Field/TextField';
import { LoadingState } from '../../components/LoadingState/LoadingState';
import { DeleteRowsDialog } from '../../components/RecordSheet/DeleteRowsDialog';
import { OutOfDateNotice } from '../../components/RecordSheet/OutOfDateNotice';
import type { StaleRow } from '../../components/RecordSheet/RecordSheet';
import {
  TABLE_WORDS,
  describeChanges,
  type ChangeWords,
} from '../../components/RecordSheet/describeChanges';
import {
  RECORDS_CHANNEL,
  announceRecords,
} from '../../components/RecordSheet/announceRecords';
import { useDoNotStoreGuard } from '../../components/RecordSheet/useDoNotStoreGuard';
import { RoundIconButton } from '../../components/RoundIconButton/RoundIconButton';
import { t, tCount } from '../../strings';
import { DoNotStoreList } from './DoNotStoreList';
import './DataProtectionPanel.css';

/** AG Grid is large, so it loads only when a sheet first opens (ADR-035). */
const RecordSheet = lazy(
  () => import('../../components/RecordSheet/RecordSheet'),
);

/** The ICO's own page on who pays the data protection fee (checked 2026-10-12). */
const ICO_FEE_URL = 'https://ico.org.uk/for-organisations/data-protection-fee/';

const NO_MARKS: ReadonlySet<string> = new Set();

/** How a search words its changes: a row may just no longer match. */
const SEARCH_WORDS: ChangeWords = {
  changed: TABLE_WORDS.changed,
  deleted: 'dataProtection.outOfDate.deleted',
  added: 'dataProtection.outOfDate.added',
};

export interface DataProtectionPanelProps {
  readonly companyId: string;
  /** For the names of downloaded files. */
  readonly companySlug: string;
}

/**
 * Data protection for the company's record tables (001.04): a note on the
 * duties a user may have, with the official source and no advice; a search
 * that finds everything about one person across every table, to download or
 * delete; and the do-not-store list.
 *
 * It says plainly what it doesn't reach, since a person asking to be
 * forgotten is owed an honest answer about where else their details are.
 */
export const DataProtectionPanel = ({
  companyId,
  companySlug,
}: DataProtectionPanelProps) => {
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState('');

  const searchFor = (text: string) => {
    setDraft(text);
    setQ(text.trim());
  };

  return (
    <div className="data-protection">
      <section aria-labelledby="data-protection-duties">
        <h2 id="data-protection-duties">
          {t('dataProtection.duties.heading')}
        </h2>
        <p>{t('dataProtection.duties.body')}</p>
        <p>
          <a href={ICO_FEE_URL} target="_blank" rel="noreferrer">
            {t('dataProtection.duties.link')}
          </a>
        </p>
        <p>{t('dataProtection.scope')}</p>
      </section>

      <RecordSearch
        companyId={companyId}
        companySlug={companySlug}
        q={q}
        draft={draft}
        onDraft={setDraft}
        onSearch={searchFor}
      />

      <DoNotStoreList companyId={companyId} onSearchFor={searchFor} />
    </div>
  );
};

/**
 * Finds rows mentioning a person in every table. The results come as one
 * editable sheet per table; ticked rows, in any of them, can be downloaded
 * or deleted together.
 */
const RecordSearch = ({
  companyId,
  companySlug,
  q,
  draft,
  onDraft,
  onSearch,
}: {
  readonly companyId: string;
  readonly companySlug: string;
  readonly q: string;
  readonly draft: string;
  readonly onDraft: (text: string) => void;
  readonly onSearch: (text: string) => void;
}) => {
  const search = useRecordSearch(companyId, q);
  const changes = useLiveRecordSearchChanges(companyId, q, search.data);
  const reloadSearch = useReloadRecordSearch(companyId, q);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const deleteAcross = useDeleteRecordsAcross(companyId);
  const [tooShort, setTooShort] = useState(false);
  const [selected, setSelected] = useState<
    Readonly<Record<string, readonly TimedRecord[]>>
  >({});
  const [confirming, setConfirming] = useState(false);
  const count = Object.values(selected).reduce((n, rows) => n + rows.length, 0);

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (draft.trim().length < 2) {
      setTooShort(true);
      return;
    }
    setSelected({});
    onSearch(draft);
  };

  const lastFound = useRef<RecordSearchResult | null>(null);
  const onFound = useCallback((result: RecordSearchResult) => {
    if (lastFound.current === result) return;
    lastFound.current = result;
    announceRecords('dataProtection.announce.found', {
      count: result.groups.reduce((n, g) => n + g.rows.length, 0),
    });
  }, []);

  const download = (rows: Readonly<Record<string, readonly TimedRecord[]>>) =>
    void downloadRecordSelection(
      companyId,
      companySlug,
      Object.fromEntries(
        Object.entries(rows)
          .filter(([, chosen]) => chosen.length > 0)
          .map(([table, chosen]) => [table, chosen.map((r) => r.id)]),
      ),
    ).catch(() => announceRecords('records.downloadFailed'));

  const confirmDelete = async () => {
    try {
      const { removed } = await deleteAcross.mutateAsync(
        Object.fromEntries(
          Object.entries(selected).map(([table, rows]) => [
            table,
            rows.map((r) => ({ id: r.id, version: r.version })),
          ]),
        ),
      );
      setSelected({});
      announceRecords('records.announce.rowsDeleted', {
        table: q,
        count: removed,
      });
    } catch (error) {
      announceRecords('records.announce.notSaved', {
        message:
          error instanceof ApiError
            ? error.message
            : t('records.error.generic'),
      });
    } finally {
      setConfirming(false);
    }
  };

  return (
    <section aria-labelledby="data-protection-search">
      {/* Focusable only from code: where focus goes after a reload. */}
      <h2 id="data-protection-search" ref={headingRef} tabIndex={-1}>
        {t('dataProtection.search.heading')}
      </h2>
      <form className="data-protection__search" onSubmit={submit}>
        <TextField
          label={t('dataProtection.search.label')}
          value={draft}
          onChange={(value) => {
            onDraft(value);
            setTooShort(false);
          }}
          description={t('dataProtection.search.hint')}
          errorMessage={
            tooShort ? t('dataProtection.search.tooShort') : undefined
          }
        />
        <Button className="react-aria-Button" type="submit">
          {t('dataProtection.search.submit')}
        </Button>
      </form>

      {q !== '' &&
        (search.isPending ? (
          <LoadingState label={t('dataProtection.search.loading')} />
        ) : search.isError ? (
          <ErrorState
            message={t('dataProtection.search.error')}
            channel={RECORDS_CHANNEL}
            onRetry={() => void search.refetch()}
          />
        ) : (
          <SearchResults
            companyId={companyId}
            result={search.data}
            changes={changes}
            onReload={() => {
              reloadSearch();
              announceRecords('records.announce.reloaded', { table: q });
              // The Reload button goes with the notice (ADR-027).
              headingRef.current?.focus();
            }}
            q={q}
            selectedCount={count}
            onFound={onFound}
            onSelect={(table, rows) =>
              setSelected((current) => ({ ...current, [table]: rows }))
            }
            onDownloadSelected={() => download(selected)}
            onDownloadAll={() =>
              download(
                Object.fromEntries(
                  search.data.groups.map((g) => [g.definition.name, g.rows]),
                ),
              )
            }
            onDeleteSelected={() => setConfirming(true)}
          />
        ))}

      {confirming && (
        <DeleteRowsDialog
          count={count}
          isPending={deleteAcross.isPending}
          onConfirm={() => void confirmDelete()}
          onDownload={() => download(selected)}
          onCancel={() => setConfirming(false)}
        />
      )}
    </section>
  );
};

/** The matches: the actions over them, then one sheet per table. */
const SearchResults = ({
  companyId,
  result,
  changes,
  onReload,
  q,
  selectedCount,
  onFound,
  onSelect,
  onDownloadSelected,
  onDownloadAll,
  onDeleteSelected,
}: {
  readonly companyId: string;
  readonly result: RecordSearchResult;
  /** What has changed elsewhere since the search ran (001.05). */
  readonly changes: LiveRecordSearchChanges;
  readonly onReload: () => void;
  readonly q: string;
  readonly selectedCount: number;
  readonly onFound: (result: RecordSearchResult) => void;
  readonly onSelect: (table: string, rows: readonly TimedRecord[]) => void;
  readonly onDownloadSelected: () => void;
  readonly onDownloadAll: () => void;
  readonly onDeleteSelected: () => void;
}) => {
  // Said once per answer, keyed on the answer itself rather than on "have I
  // run?", which StrictMode's double effect would spend.
  useEffect(() => onFound(result), [result, onFound]);

  if (result.groups.length === 0) {
    return <p>{t('dataProtection.search.none', { q })}</p>;
  }
  return (
    <>
      {changes.any && (
        <OutOfDateNotice
          message={`${t('records.outOfDate.intro')} ${describeChanges(changes, SEARCH_WORDS)}. ${t('records.outOfDate.hint')}`}
          announcement="dataProtection.announce.outOfDate"
          onReload={onReload}
        />
      )}
      {result.truncated && (
        <p className="table-view__notice">
          {t('dataProtection.search.truncated')}
        </p>
      )}
      <div className="data-protection__actions">
        {/* Words, not a second download icon beside the first. */}
        <Button
          className="react-aria-Button tcp-button--outline"
          onPress={onDownloadAll}
        >
          {t('dataProtection.search.downloadAll')}
        </Button>
        <RoundIconButton
          icon={Download}
          label={tCount('records.selected.download', selectedCount)}
          outline
          isDisabled={selectedCount === 0}
          onPress={onDownloadSelected}
        />
        <RoundIconButton
          icon={Trash2}
          label={tCount('records.selected.delete', selectedCount)}
          outline
          isDisabled={selectedCount === 0}
          onPress={onDeleteSelected}
        />
      </div>
      {result.groups.map((group) => (
        <SearchGroup
          key={group.definition.name}
          companyId={companyId}
          group={group}
          changes={changes.byTable.get(group.definition.name)}
          onSelect={(rows) => onSelect(group.definition.name, rows)}
        />
      ))}
    </>
  );
};

/** One table's matching rows, editable in place like the table's own sheet. */
const SearchGroup = ({
  companyId,
  group,
  changes,
  onSelect,
}: {
  readonly companyId: string;
  readonly group: RecordSearchResult['groups'][number];
  readonly changes: RowChanges | undefined;
  readonly onSelect: (rows: readonly TimedRecord[]) => void;
}) => {
  const table = group.definition.name;
  const update = useUpdateRecord(companyId, table);
  const { guard, dialog } = useDoNotStoreGuard();
  const headingId = useId();
  const usageId = useId();
  /** Rows changed elsewhere: marked, and not editable until a reload. */
  const staleRows = useMemo(
    () =>
      new Map<string, StaleRow>([
        ...[...(changes?.changed ?? [])].map((id) => [id, 'changed'] as const),
        ...[...(changes?.deleted ?? [])].map((id) => [id, 'deleted'] as const),
      ]),
    [changes],
  );

  const onEdit = (row: TimedRecord, field: string, value: unknown) => {
    guard((confirmDoNotStore) =>
      update.mutateAsync({
        id: row.id,
        changes: { [field]: value },
        version: row.version,
        confirmDoNotStore,
      }),
    )
      .then((saved) => {
        if (saved !== undefined) {
          announceRecords('records.announce.saved', { field, row: table });
        }
      })
      .catch((error: unknown) =>
        announceRecords('records.announce.notSaved', {
          message:
            error instanceof ApiError
              ? error.message
              : t('records.error.generic'),
        }),
      );
  };

  return (
    <section aria-labelledby={headingId} className="data-protection__group">
      <h3 id={headingId}>
        {table}{' '}
        <span className="table-view__count">
          {tCount('dataProtection.search.group', group.rows.length)}
        </span>
      </h3>
      <p id={usageId} className="visually-hidden">
        {t('records.usage')}
      </p>
      <Suspense fallback={<LoadingState label={t('records.loading')} />}>
        <RecordSheet
          table={table}
          label={t('dataProtection.search.sheet', { table })}
          definition={group.definition}
          rows={group.rows}
          editedCells={NO_MARKS}
          addedRows={NO_MARKS}
          onEdit={onEdit}
          onFocusRow={() => undefined}
          onUndoKey={() => undefined}
          describedBy={usageId}
          onSelectionChange={onSelect}
          staleRows={staleRows}
        />
      </Suspense>
      {dialog}
    </section>
  );
};
