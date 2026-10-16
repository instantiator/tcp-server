import {
  CellStyleModule,
  ClientSideRowModelModule,
  DateFilterModule,
  ModuleRegistry,
  NumberEditorModule,
  NumberFilterModule,
  PaginationModule,
  QuickFilterModule,
  RenderApiModule,
  RowApiModule,
  RowSelectionModule,
  SelectEditorModule,
  TextEditorModule,
  TextFilterModule,
  ValidationModule,
  themeQuartz,
  type CellFocusedEvent,
  type CellKeyDownEvent,
  type ColDef,
  type EditableCallbackParams,
  type GridApi,
  type GridReadyEvent,
  type IRowNode,
  type RowSelectionOptions,
  type SelectionChangedEvent,
} from 'ag-grid-community';
import { AgGridReact, type CustomCellRendererProps } from 'ag-grid-react';
import { fieldOrder } from '@tcp/shared/client';
import { CircleSlash, Pencil, Plus, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import type { RecordTableDefinition, TimedRecord } from '../../api/dtos';
import { t } from '../../strings';
import { Icon } from '../Icon/Icon';
import './RecordSheet.css';

ModuleRegistry.registerModules([
  ClientSideRowModelModule,
  TextEditorModule,
  NumberEditorModule,
  SelectEditorModule,
  TextFilterModule,
  NumberFilterModule,
  DateFilterModule,
  PaginationModule,
  CellStyleModule,
  RenderApiModule,
  RowApiModule,
  RowSelectionModule,
  QuickFilterModule,
  // Explains a misconfigured option in the console, in development only.
  ...(import.meta.env.DEV ? [ValidationModule] : []),
  // Translation (not yet done): AG Grid's own text needs `LocaleModule`
  // registered here, alongside `getLocaleText` on the grid below.
]);

/**
 * The grid's look, from the application's own theme tokens, so light, dark
 * and high contrast all reach it (ADR-035). The header row is set apart by
 * its background and weight.
 */
const sheetTheme = themeQuartz.withParams({
  backgroundColor: 'var(--tcp-color-surface)',
  foregroundColor: 'var(--tcp-color-text)',
  headerBackgroundColor: 'var(--tcp-color-bg)',
  headerTextColor: 'var(--tcp-color-text)',
  headerFontWeight: 700,
  borderColor: 'var(--tcp-color-border)',
  accentColor: 'var(--tcp-color-focus)',
  fontFamily: 'var(--tcp-font-family)',
});

/** Rows a page shows. Pages, not virtual scrolling, so every row is in the DOM (ADR-035). */
const PAGE_SIZE = 100;

/**
 * Several rows at once, by a checkbox column; the header's box picks every
 * row the filters show. A click in a cell still edits it rather than
 * selecting the row, so selecting is always a deliberate act.
 */
const ROW_SELECTION: RowSelectionOptions = {
  mode: 'multiRow',
  checkboxes: true,
  headerCheckbox: true,
  selectAll: 'filtered',
  enableClickSelection: false,
};

/**
 * The "Updated" column's display: the reader's own date and time format.
 * Translation: this follows the browser's locale, not the app's language. When
 * the app chooses a language, pass that locale here instead of `undefined`.
 */
const updatedFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** Shows a boolean as the words the user types to set it. */
const booleanText = (value: unknown): string =>
  value === true
    ? t('records.boolean.yes')
    : value === false
      ? t('records.boolean.no')
      : '';

/** How a row on screen has changed elsewhere since it was read (001.05). */
export type StaleRow = 'changed' | 'deleted';

/** A cell's text plus its marks. Context carries the marks, so they refresh without new column definitions. */
interface SheetContext {
  readonly editedCells: ReadonlySet<string>;
  readonly addedRows: ReadonlySet<string>;
  readonly staleRows: ReadonlyMap<string, StaleRow>;
  readonly firstField: string;
}

/** No rows changed elsewhere. */
const NO_STALE_ROWS: ReadonlyMap<string, StaleRow> = new Map();

/**
 * A cell with a mark when this session changed it, or when its row changed
 * elsewhere and so can't be edited: an icon for sight and hidden words for a
 * screen reader, so the mark is never colour alone. The row's first cell
 * carries the "elsewhere" mark, so it is heard on arriving at the row.
 */
const MarkedCell = (
  props: CustomCellRendererProps<TimedRecord, unknown, SheetContext>,
) => {
  const { data, colDef, valueFormatted, value, context } = props;
  const field = colDef?.colId ?? '';
  const edited =
    data !== undefined && context.editedCells.has(`${data.id}:${field}`);
  const first = data !== undefined && field === context.firstField;
  const added = first && context.addedRows.has(data.id);
  const stale = first ? context.staleRows.get(data.id) : undefined;
  const text =
    valueFormatted ??
    (typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : '');
  return (
    <span className="record-sheet__cell">
      {text}
      {stale !== undefined ? (
        <span className="record-sheet__mark record-sheet__mark--stale">
          <Icon icon={stale === 'deleted' ? CircleSlash : RefreshCw} />
          <span className="visually-hidden">
            {t(
              stale === 'deleted'
                ? 'records.deletedElsewhere'
                : 'records.changedElsewhere',
            )}
          </span>
        </span>
      ) : (
        (edited || added) && (
          <span className="record-sheet__mark">
            <Icon icon={added ? Plus : Pencil} />
            <span className="visually-hidden">
              {t(added ? 'records.added' : 'records.changed')}
            </span>
          </span>
        )
      )}
    </span>
  );
};

export interface RecordSheetProps {
  readonly table: string;
  readonly definition: RecordTableDefinition;
  /** Most recently changed first, as loaded; edits keep their place. */
  readonly rows: readonly TimedRecord[];
  readonly editedCells: ReadonlySet<string>;
  readonly addedRows: ReadonlySet<string>;
  /** A cell was edited and left: save `value` (`null` empties the field). */
  readonly onEdit: (row: TimedRecord, field: string, value: unknown) => void;
  /** The row of the focused cell, or `null` when no cell has focus. */
  readonly onFocusRow: (row: TimedRecord | null) => void;
  /** Ctrl+Z or Cmd+Z on a cell that isn't being edited. */
  readonly onUndoKey: () => void;
  /** The id of the usage notes, linked to the grid for screen readers. */
  readonly describedBy: string;
  /** Receives the grid's API, so the caller can move focus back into it. */
  readonly onApi?: (api: GridApi<TimedRecord> | null) => void;
  /** Where filter menus open, to stay inside the office view in full screen. */
  readonly portalContainer?: Element | undefined;
  /**
   * Turns on row selection, and hears the selected rows whenever they change.
   * Without it, the sheet has no checkbox column.
   */
  readonly onSelectionChange?: (rows: TimedRecord[]) => void;
  /** Fields shown but never edited, such as who added an entry. */
  readonly readOnlyFields?: ReadonlySet<string>;
  /**
   * Rows changed or deleted elsewhere since they were read (001.05): marked,
   * and not editable until the sheet is reloaded.
   */
  readonly staleRows?: ReadonlyMap<string, StaleRow>;
  /** Nothing can be edited: the table was deleted elsewhere. */
  readonly readOnly?: boolean;
  /** Shows only the rows with this text in any cell. */
  readonly quickFilter?: string;
  /** The grid's accessible name, where "{table} records" would be wrong. */
  readonly label?: string;
}

/**
 * The editable spreadsheet for one record table (AG Grid, ADR-035), the
 * default export so it loads only when a sheet opens.
 *
 * **Edits don't move rows.** The default order is "most recently changed
 * first", but it sorts by each row's position in `rows`, not by its timestamp,
 * so a row just edited stays under the cursor (ADR-027) until the table is
 * reloaded. A sort the user picks re-applies as values change.
 */
const RecordSheet = ({
  table,
  definition,
  rows,
  editedCells,
  addedRows,
  onEdit,
  onFocusRow,
  onUndoKey,
  describedBy,
  onApi,
  portalContainer,
  onSelectionChange,
  readOnlyFields,
  quickFilter,
  label,
  staleRows = NO_STALE_ROWS,
  readOnly = false,
}: RecordSheetProps) => {
  const apiRef = useRef<GridApi<TimedRecord> | null>(null);
  const fields = useMemo(() => fieldOrder(definition), [definition]);

  // The position of each row in `rows`: the default sort order.
  const position = useRef(new Map<string, number>());
  position.current = new Map(rows.map((row, i) => [row.id, i]));

  const onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;

  // Read at edit time, so a row changing elsewhere locks without new columns.
  const editableRef = useRef((id: string) => !readOnly && !staleRows.has(id));
  editableRef.current = (id: string) => !readOnly && !staleRows.has(id);

  const columnDefs = useMemo((): ColDef<TimedRecord>[] => {
    const required = new Set(definition.schema.required ?? []);
    const columns = fields.map((field): ColDef<TimedRecord> => {
      const schema = definition.schema.properties[field];
      const numeric = schema.type === 'number' || schema.type === 'integer';
      const isDate = schema.type === 'string' && schema.format === 'date';
      return {
        colId: field,
        editable: readOnlyFields?.has(field)
          ? false
          : ({ data }: EditableCallbackParams<TimedRecord>) =>
              data !== undefined && editableRef.current(data.id),
        headerName: definition.primaryKey.includes(field)
          ? t('records.column.key', { field })
          : field,
        headerTooltip: schema.description,
        valueGetter: ({ data }) => data?.data[field],
        valueFormatter:
          schema.type === 'boolean'
            ? ({ value }) => booleanText(value)
            : undefined,
        valueSetter: ({ data, oldValue, newValue }) => {
          // The grid types editor values as `any`; read them as unknown.
          const raw: unknown = newValue;
          const before: unknown = oldValue;
          const value =
            schema.type === 'boolean'
              ? raw === 'true'
                ? true
                : raw === 'false'
                  ? false
                  : null
              : raw === '' || raw === undefined
                ? null
                : raw;
          if (value !== (before ?? null)) {
            onEditRef.current(data, field, value);
          }
          // The grid shows the saved row when it comes back, not the draft.
          return false;
        },
        cellEditor: numeric
          ? 'agNumberCellEditor'
          : schema.type === 'boolean'
            ? 'agSelectCellEditor'
            : 'agTextCellEditor',
        cellEditorParams:
          schema.type === 'boolean'
            ? { values: ['', 'true', 'false'] }
            : schema.type === 'integer'
              ? { step: 1, precision: 0 }
              : undefined,
        filter: numeric
          ? 'agNumberColumnFilter'
          : isDate
            ? 'agDateColumnFilter'
            : 'agTextColumnFilter',
        filterParams: isDate
          ? {
              comparator: (day: Date, cell: unknown) => {
                if (typeof cell !== 'string') return -1;
                const at = new Date(`${cell}T00:00:00`).getTime();
                return at === day.getTime() ? 0 : at < day.getTime() ? -1 : 1;
              },
            }
          : undefined,
        cellRenderer: MarkedCell,
        headerClass: required.has(field) ? 'record-sheet__required' : undefined,
      };
    });
    columns.push({
      colId: 'updatedAt',
      headerName: t('records.column.updated'),
      editable: false,
      valueGetter: ({ data }) => data?.updatedAt,
      valueFormatter: ({ value }) =>
        typeof value === 'string' ? updatedFormat.format(new Date(value)) : '',
      filter: 'agDateColumnFilter',
      filterParams: {
        comparator: (day: Date, cell: unknown) => {
          if (typeof cell !== 'string') return -1;
          const at = new Date(cell);
          at.setHours(0, 0, 0, 0);
          return at.getTime() === day.getTime() ? 0 : at < day ? -1 : 1;
        },
      },
      initialSort: 'desc',
      comparator: (
        _a: unknown,
        _b: unknown,
        nodeA: IRowNode<TimedRecord>,
        nodeB: IRowNode<TimedRecord>,
      ) =>
        (position.current.get(nodeB.data?.id ?? '') ?? -1) -
        (position.current.get(nodeA.data?.id ?? '') ?? -1),
    });
    return columns;
  }, [definition, fields, readOnlyFields]);

  const context = useMemo(
    (): SheetContext => ({
      editedCells,
      addedRows,
      staleRows,
      firstField: fields[0] ?? '',
    }),
    [editedCells, addedRows, staleRows, fields],
  );

  // New marks: redraw the cells, which read them from the context.
  useEffect(() => {
    apiRef.current?.refreshCells({ force: true });
  }, [context]);

  const rowData = useMemo(() => [...rows], [rows]);

  return (
    <div className="record-sheet">
      <AgGridReact<TimedRecord>
        // Translation (not yet done): the text AG Grid writes itself — filter
        // menus ("Contains", "Equals"), pagination ("Page 1 of 1"), "No Rows To
        // Show", and its ARIA labels — comes from its built-in English. To
        // translate it, register `LocaleModule` (above) and add
        // `getLocaleText={({ key, defaultValue }) => …}` here, looking each key
        // up through `t()` (say as `records.grid.<key>`) and falling back to
        // `defaultValue`. Prefer `getLocaleText` to a static `localeText` map:
        // both are read only when the grid is created, but the callback keeps
        // every string behind `t()`. Our own text (headers, true/false, marks)
        // already goes through `t()`. Tracked in docs/outstanding-issues.md.
        theme={sheetTheme}
        rowData={rowData}
        columnDefs={columnDefs}
        context={context}
        getRowId={({ data }) => data.id}
        defaultColDef={{
          editable: true,
          sortable: true,
          resizable: true,
          minWidth: 120,
          flex: 1,
        }}
        domLayout="autoHeight"
        pagination
        paginationPageSize={PAGE_SIZE}
        paginationPageSizeSelector={false}
        rowSelection={
          onSelectionChange === undefined ? undefined : ROW_SELECTION
        }
        onSelectionChanged={({ api }: SelectionChangedEvent<TimedRecord>) =>
          onSelectionChange?.(api.getSelectedRows())
        }
        quickFilterText={quickFilter}
        ensureDomOrder
        suppressRowVirtualisation
        suppressColumnVirtualisation
        singleClickEdit
        stopEditingWhenCellsLoseFocus
        popupParent={
          portalContainer instanceof HTMLElement ? portalContainer : undefined
        }
        onGridReady={({ api }: GridReadyEvent<TimedRecord>) => {
          apiRef.current = api;
          api.setGridAriaProperty(
            'label',
            label ?? t('records.sheet.label', { table }),
          );
          api.setGridAriaProperty('describedby', describedBy);
          onApi?.(api);
        }}
        onGridPreDestroyed={() => {
          apiRef.current = null;
          onApi?.(null);
        }}
        onCellFocused={({ api, rowIndex }: CellFocusedEvent<TimedRecord>) =>
          onFocusRow(
            rowIndex === null
              ? null
              : (api.getDisplayedRowAtIndex(rowIndex)?.data ?? null),
          )
        }
        onCellKeyDown={(event: CellKeyDownEvent<TimedRecord>) => {
          const key = event.event;
          if (
            key instanceof KeyboardEvent &&
            (key.ctrlKey || key.metaKey) &&
            key.key.toLowerCase() === 'z' &&
            event.api.getEditingCells().length === 0
          ) {
            key.preventDefault();
            onUndoKey();
          }
        }}
      />
    </div>
  );
};

export default RecordSheet;
