import { fieldOrder } from '@tcp/shared/client';
import type { GridApi } from 'ag-grid-community';
import { Download, Plus, Trash2, Undo2 } from 'lucide-react';
import {
  Suspense,
  lazy,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ApiError, recordErrorBody } from '../../api/errors';
import type { TimedRecord } from '../../api/dtos';
import {
  downloadRecordSelection,
  downloadRecordTableCsv,
  useAddRecord,
  useDeleteRecord,
  useDeleteRecords,
  useLiveRecordTableChanges,
  useRecordTable,
  useReloadRecordTable,
  useUpdateRecord,
} from '../../api/hooks';
import { t, tCount } from '../../strings';
import { ConfirmDialog } from '../Dialog/ConfirmDialog';
import { ErrorState } from '../ErrorState/ErrorState';
import { LoadingState } from '../LoadingState/LoadingState';
import { RoundIconButton } from '../RoundIconButton/RoundIconButton';
import { AddRowDialog } from './AddRowDialog';
import { DeleteRowsDialog } from './DeleteRowsDialog';
import { describeChanges } from './describeChanges';
import { OutOfDateNotice } from './OutOfDateNotice';
import type { StaleRow } from './RecordSheet';
import { retentionSummary } from './retention';
import { RecordTableActions } from './RecordTableActions';
import { RECORDS_CHANNEL, announceRecords } from './announceRecords';
import { rowLabel } from './fieldInput';
import { useDoNotStoreGuard } from './useDoNotStoreGuard';
import { useUndoStack, type RecordChange } from './useUndoStack';
import './TableView.css';

/** AG Grid is large, so it loads only when a sheet first opens (ADR-035). */
const RecordSheet = lazy(() => import('./RecordSheet'));

export interface TableViewProps {
  readonly companyId: string;
  readonly companySlug: string;
  readonly table: string;
  /**
   * A heading level for the table's name, or none where something else
   * already names it (the dialog's own heading).
   */
  readonly titleLevel?: 2 | 3;
  /** Called once the table is deleted. */
  readonly onDropped?: () => void;
  readonly portalContainer?: Element | undefined;
}

/** What an undo will do, in words: "the change to qty of A1". */
const describeChange = (change: RecordChange): string =>
  change.kind === 'edit'
    ? t('records.change.edit', { field: change.field, row: change.row })
    : t(
        change.kind === 'add' ? 'records.change.add' : 'records.change.delete',
        {
          row: change.row,
        },
      );

/** Announces why a change wasn't saved: moved on elsewhere, refused, or failed. */
const announceNotSaved = (error: unknown): void => {
  if (error instanceof ApiError && recordErrorBody(error).code === 'stale') {
    announceRecords('records.announce.stale');
  } else {
    announceRecords('records.announce.notSaved', {
      message:
        error instanceof ApiError ? error.message : t('records.error.generic'),
    });
  }
};

/**
 * One record table as an editable sheet (001.03): its title and actions,
 * then the grid. The office dialog and the Tables tab both show this.
 *
 * Every change is saved as it is made, against the row's version, and kept
 * on an undo list for as long as this view shows this table — so a caller
 * showing a different table must remount it (`key={table}`). Undo is ours,
 * not AG Grid's, because it also has to undo added and deleted rows.
 */
export const TableView = ({
  companyId,
  companySlug,
  table,
  titleLevel,
  onDropped,
  portalContainer,
}: TableViewProps) => {
  const query = useRecordTable(companyId, table);
  const update = useUpdateRecord(companyId, table);
  const addRecord = useAddRecord(companyId, table);
  const deleteRecord = useDeleteRecord(companyId, table);
  const deleteRecords = useDeleteRecords(companyId, table);
  const reload = useReloadRecordTable(companyId, table);
  const changes = useLiveRecordTableChanges(companyId, table, query.data);
  /** Rows changed elsewhere: marked, and not editable until a reload. */
  const staleRows = useMemo(
    () =>
      new Map<string, StaleRow>([
        ...[...changes.changed].map((id) => [id, 'changed'] as const),
        ...[...changes.deleted].map((id) => [id, 'deleted'] as const),
      ]),
    [changes],
  );
  const { guard, dialog: doNotStoreDialog } =
    useDoNotStoreGuard(portalContainer);
  const undo = useUndoStack();
  const usageId = useId();
  const titleId = useId();
  const apiRef = useRef<GridApi<TimedRecord> | null>(null);
  const [focusedRow, setFocusedRow] = useState<TimedRecord | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [undoing, setUndoing] = useState(false);
  /** Rows ticked in the sheet: Download and Delete act on these when there are any. */
  const [selected, setSelected] = useState<TimedRecord[]>([]);
  const [confirmingBulk, setConfirmingBulk] = useState(false);

  const definition = query.data?.definition;
  const labelOf = useCallback(
    (row: TimedRecord) =>
      definition === undefined ? '' : rowLabel(definition.primaryKey, row.data),
    [definition],
  );

  const onEdit = useCallback(
    (row: TimedRecord, field: string, value: unknown) => {
      const save = async () => {
        const saved = await guard((confirmDoNotStore) =>
          update.mutateAsync({
            id: row.id,
            changes: { [field]: value },
            version: row.version,
            confirmDoNotStore,
          }),
        );
        if (saved === undefined) return;
        undo.push({
          kind: 'edit',
          rowId: row.id,
          row: labelOf(row),
          field,
          from: row.data[field],
        });
        announceRecords('records.announce.saved', {
          field,
          row: labelOf(row),
        });
      };
      save().catch(announceNotSaved);
    },
    [guard, update, undo, labelOf],
  );

  const downloadSelected = () =>
    void downloadRecordSelection(companyId, companySlug, {
      [table]: selected.map((row) => row.id),
    }).catch(() => announceRecords('records.downloadFailed'));

  const confirmBulkDelete = async () => {
    const rows = selected;
    try {
      const { removed } = await deleteRecords.mutateAsync(
        rows.map((row) => ({ id: row.id, version: row.version })),
      );
      setConfirmingBulk(false);
      setSelected([]);
      announceRecords('records.announce.rowsDeleted', {
        table,
        count: removed,
      });
    } catch (error) {
      setConfirmingBulk(false);
      announceNotSaved(error);
    }
  };

  const runUndo = async () => {
    const change = undo.last;
    if (change === undefined || undoing) return;
    const current = query.data?.rows.find((r) => r.id === change.rowId);
    setUndoing(true);
    try {
      if (change.kind === 'delete') {
        const restored = await addRecord.mutateAsync({
          data: { ...change.data },
        });
        undo.pop(restored.id);
      } else if (current === undefined) {
        throw new Error('row gone');
      } else if (change.kind === 'edit') {
        await update.mutateAsync({
          id: change.rowId,
          changes: { [change.field]: change.from ?? null },
          version: current.version,
        });
        undo.pop();
      } else {
        await deleteRecord.mutateAsync({
          id: change.rowId,
          version: current.version,
        });
        undo.pop();
      }
      announceRecords('records.announce.undone', {
        change: describeChange(change),
      });
    } catch (error) {
      announceRecords('records.announce.undoFailed', {
        message:
          error instanceof ApiError
            ? error.message
            : t('records.error.generic'),
      });
    } finally {
      setUndoing(false);
    }
  };

  const confirmDelete = async () => {
    const row = focusedRow;
    if (row === null) return;
    const api = apiRef.current;
    const index = api?.getRowNode(row.id)?.rowIndex ?? 0;
    try {
      await deleteRecord.mutateAsync({ id: row.id, version: row.version });
      setConfirmingDelete(false);
      setFocusedRow(null);
      undo.push({
        kind: 'delete',
        rowId: row.id,
        row: labelOf(row),
        data: row.data,
      });
      announceRecords('records.announce.deleted', { row: labelOf(row) });
      // A stable neighbour, not the page body (ADR-027): the cell that took
      // the deleted row's place, or the new last row.
      const remaining = api?.getDisplayedRowCount() ?? 0;
      const firstField =
        definition === undefined ? undefined : fieldOrder(definition)[0];
      if (api && remaining > 0 && firstField !== undefined) {
        api.setFocusedCell(Math.min(index, remaining - 1), firstField);
      }
    } catch (error) {
      setConfirmingDelete(false);
      announceNotSaved(error);
    }
  };

  const reloadTable = () => {
    undo.clear();
    reload();
  };

  // The notice's Reload button goes once the sheet is current, so focus moves
  // to the sheet's first cell rather than falling to the page (ADR-027).
  const reloadFromNotice = () => {
    reloadTable();
    announceRecords('records.announce.reloaded', { table });
    const firstField =
      definition === undefined ? undefined : fieldOrder(definition)[0];
    if (firstField !== undefined) apiRef.current?.setFocusedCell(0, firstField);
  };

  const focusedStale = focusedRow !== null && staleRows.has(focusedRow.id);
  const Title = titleLevel === 3 ? 'h3' : 'h2';
  const records = query.data?.total ?? 0;

  return (
    // A named region either way, so it is a landmark a screen reader can jump to.
    <section
      className="table-view"
      aria-labelledby={titleLevel === undefined ? undefined : titleId}
      aria-label={titleLevel === undefined ? table : undefined}
    >
      <div className="table-view__bar">
        {titleLevel !== undefined && (
          <Title id={titleId} className="table-view__title">
            {table}
            <span className="table-view__count">
              {' '}
              {tCount('records.count', records)}
            </span>
          </Title>
        )}
        <div className="table-view__actions">
          <RoundIconButton
            icon={Download}
            label={
              selected.length > 0
                ? tCount('records.selected.download', selected.length)
                : t('records.download', { table })
            }
            outline
            portalContainer={portalContainer}
            onPress={() =>
              selected.length > 0
                ? downloadSelected()
                : void downloadRecordTableCsv(
                    companyId,
                    companySlug,
                    table,
                  ).catch(() => announceRecords('records.downloadFailed'))
            }
          />
          <RoundIconButton
            icon={Plus}
            label={t('records.addRow', { table })}
            outline
            isDisabled={definition === undefined || changes.dropped}
            portalContainer={portalContainer}
            onPress={() => setAdding(true)}
          />
          <RoundIconButton
            icon={Trash2}
            label={
              selected.length > 0
                ? tCount('records.selected.delete', selected.length)
                : focusedRow === null
                  ? t('records.deleteRow.none')
                  : focusedStale
                    ? t('records.deleteRow.stale', { row: labelOf(focusedRow) })
                    : t('records.deleteRow', { row: labelOf(focusedRow) })
            }
            outline
            isDisabled={
              changes.dropped ||
              (selected.length === 0 && (focusedRow === null || focusedStale))
            }
            portalContainer={portalContainer}
            onPress={() =>
              selected.length > 0
                ? setConfirmingBulk(true)
                : setConfirmingDelete(true)
            }
          />
          <RoundIconButton
            icon={Undo2}
            label={
              undo.last === undefined
                ? t('records.undo.none')
                : t('records.undo', { change: describeChange(undo.last) })
            }
            outline
            isDisabled={undo.last === undefined || changes.dropped}
            isPending={undoing}
            portalContainer={portalContainer}
            onPress={() => void runUndo()}
          />
          {/* Every action left in the menu would fail on a deleted table. */}
          {!changes.dropped && (
            <RecordTableActions
              companyId={companyId}
              companySlug={companySlug}
              table={table}
              records={records}
              onReload={reloadTable}
              onDropped={onDropped}
              definition={definition}
              portalContainer={portalContainer}
            />
          )}
        </div>
      </div>

      {definition !== undefined && retentionSummary(definition) !== null && (
        <p className="table-view__notice">{retentionSummary(definition)}</p>
      )}

      {changes.dropped ? (
        <OutOfDateNotice
          message={t('records.outOfDate.dropped')}
          announcement="records.announce.droppedElsewhere"
          announcementParams={{ table }}
        />
      ) : (
        changes.any && (
          <OutOfDateNotice
            message={`${t('records.outOfDate.intro')} ${describeChanges(changes)}. ${t('records.outOfDate.hint')}`}
            announcement="records.announce.outOfDate"
            announcementParams={{ table }}
            onReload={reloadFromNotice}
          />
        )
      )}

      <p id={usageId} className="visually-hidden">
        {t('records.usage')}
      </p>

      {query.isPending ? (
        <LoadingState label={t('records.loading')} />
      ) : query.isError ? (
        <ErrorState
          message={t('records.error')}
          channel={RECORDS_CHANNEL}
          onRetry={reload}
        />
      ) : (
        <>
          {query.data.truncated && (
            <p className="table-view__notice">
              {t('records.truncated', {
                shown: query.data.rows.length,
                total: query.data.total,
              })}
            </p>
          )}
          <Suspense fallback={<LoadingState label={t('records.loading')} />}>
            <RecordSheet
              table={table}
              definition={query.data.definition}
              rows={query.data.rows}
              editedCells={undo.editedCells}
              addedRows={undo.addedRows}
              onEdit={onEdit}
              onFocusRow={setFocusedRow}
              onUndoKey={() => void runUndo()}
              describedBy={usageId}
              onApi={(api) => {
                apiRef.current = api;
              }}
              onSelectionChange={setSelected}
              portalContainer={portalContainer}
              staleRows={staleRows}
              readOnly={changes.dropped}
            />
          </Suspense>
        </>
      )}

      {adding && definition !== undefined && (
        <AddRowDialog
          companyId={companyId}
          definition={definition}
          portalContainer={portalContainer}
          onClose={() => setAdding(false)}
          onAdded={(row) => {
            undo.push({ kind: 'add', rowId: row.id, row: labelOf(row) });
            announceRecords('records.announce.added', { row: labelOf(row) });
          }}
        />
      )}

      <ConfirmDialog
        isOpen={confirmingDelete && focusedRow !== null}
        heading={t('records.deleteRow.heading', {
          row: focusedRow === null ? '' : labelOf(focusedRow),
        })}
        message={t('records.deleteRow.message')}
        confirmLabel={t('records.deleteRow.confirm')}
        portalContainer={portalContainer}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setConfirmingDelete(false)}
      />

      {confirmingBulk && (
        <DeleteRowsDialog
          count={selected.length}
          isPending={deleteRecords.isPending}
          portalContainer={portalContainer}
          onConfirm={() => void confirmBulkDelete()}
          onDownload={downloadSelected}
          onCancel={() => setConfirmingBulk(false)}
        />
      )}

      {doNotStoreDialog}
    </section>
  );
};
