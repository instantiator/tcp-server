import { Trash2 } from 'lucide-react';
import {
  Suspense,
  lazy,
  useId,
  useMemo,
  useState,
  type SubmitEvent,
} from 'react';
import { Button } from 'react-aria-components';
import { ApiError } from '../../api/errors';
import type {
  DoNotStoreEntry,
  RecordTableDefinition,
  TimedRecord,
} from '../../api/dtos';
import {
  useAddDoNotStore,
  useDoNotStoreList,
  useRemoveDoNotStore,
  useUpdateDoNotStore,
} from '../../api/hooks';
import { ConfirmDialog } from '../../components/Dialog/ConfirmDialog';
import { ErrorState } from '../../components/ErrorState/ErrorState';
import { TextField } from '../../components/Field/TextField';
import { LoadingState } from '../../components/LoadingState/LoadingState';
import {
  RECORDS_CHANNEL,
  announceRecords,
} from '../../components/RecordSheet/announceRecords';
import { RoundIconButton } from '../../components/RoundIconButton/RoundIconButton';
import { t, tCount } from '../../strings';

/** AG Grid is large, so it loads only when a sheet first opens (ADR-035). */
const RecordSheet = lazy(
  () => import('../../components/RecordSheet/RecordSheet'),
);

const NO_MARKS: ReadonlySet<string> = new Set();

/** The sheet's columns, as the record sheet reads a table's. */
const VALUE = t('dataProtection.list.column.value');
const NOTE = t('dataProtection.list.column.note');
const ADDED_BY = t('dataProtection.list.column.addedBy');
const ADDED = t('dataProtection.list.column.added');

/** Who added an entry, and when, are history: shown, never edited. */
const READ_ONLY: ReadonlySet<string> = new Set([ADDED_BY, ADDED]);

/** The list drawn as a table, so it reuses the record sheet's grid. */
const LIST_DEFINITION: RecordTableDefinition = {
  id: 'do-not-store',
  name: 'do-not-store',
  purpose: '',
  primaryKey: [VALUE],
  uniqueKeys: [],
  retention: null,
  schema: {
    properties: {
      [VALUE]: { type: 'string' },
      [NOTE]: { type: 'string' },
      [ADDED_BY]: { type: 'string' },
      [ADDED]: { type: 'string' },
    },
    required: [VALUE],
  },
};

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/** One entry as a sheet row. */
const asRow = (entry: DoNotStoreEntry): TimedRecord => ({
  id: entry.id,
  version: 1,
  createdAt: entry.createdAt,
  updatedAt: entry.updatedAt,
  data: {
    [VALUE]: entry.value,
    [NOTE]: entry.note ?? '',
    [ADDED_BY]:
      entry.addedByRole === 'agent'
        ? t('dataProtection.list.byAgent')
        : (entry.addedById ?? ''),
    [ADDED]: dateFormat.format(new Date(entry.createdAt)),
  },
});

const notChanged = (error: unknown) =>
  announceRecords('dataProtection.announce.listNotChanged', {
    message:
      error instanceof ApiError ? error.message : t('records.error.generic'),
  });

export interface DoNotStoreListProps {
  readonly companyId: string;
  /** Runs the record search for an entry just added. */
  readonly onSearchFor: (value: string) => void;
}

/**
 * The company's do-not-store list (001.04): add an entry, find one with the
 * filter, correct one in place, or remove those added in error. The list is
 * the record sheet's grid, so it reads and behaves like every other table.
 *
 * Once an entry is added, a button offers to search the records for it: the
 * list only stops new data, and the person may already be on file.
 */
export const DoNotStoreList = ({
  companyId,
  onSearchFor,
}: DoNotStoreListProps) => {
  const list = useDoNotStoreList(companyId);
  const add = useAddDoNotStore(companyId);
  const update = useUpdateDoNotStore(companyId);
  const remove = useRemoveDoNotStore(companyId);
  const headingId = useId();
  const usageId = useId();
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | undefined>();
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<readonly TimedRecord[]>([]);
  const [confirming, setConfirming] = useState(false);
  const rows = useMemo(() => (list.data ?? []).map(asRow), [list.data]);

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const entry = await add.mutateAsync({
        value,
        ...(note.trim() !== '' && { note }),
      });
      setValue('');
      setNote('');
      setJustAdded(entry.value);
      announceRecords('dataProtection.announce.listChanged');
    } catch (error) {
      setProblem(
        error instanceof ApiError ? error.message : t('records.error.generic'),
      );
    }
  };

  const onEdit = (row: TimedRecord, field: string, edited: unknown) => {
    const text = typeof edited === 'string' ? edited : '';
    update
      .mutateAsync(
        field === VALUE
          ? { id: row.id, value: text }
          : { id: row.id, note: text === '' ? null : text },
      )
      .then(() => announceRecords('dataProtection.announce.listChanged'))
      .catch(notChanged);
  };

  const confirmRemove = async () => {
    try {
      for (const row of selected) await remove.mutateAsync(row.id);
      setSelected([]);
      announceRecords('dataProtection.announce.listChanged');
    } catch (error) {
      notChanged(error);
    } finally {
      setConfirming(false);
    }
  };

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId}>{t('dataProtection.list.heading')}</h2>
      <p>{t('dataProtection.list.body')}</p>
      <form
        className="data-protection__search"
        onSubmit={(event) => void submit(event)}
      >
        <TextField
          label={t('dataProtection.list.value')}
          value={value}
          onChange={(next) => {
            setValue(next);
            setProblem(undefined);
          }}
          errorMessage={problem}
          isRequired
        />
        <TextField
          label={t('dataProtection.list.note')}
          value={note}
          onChange={setNote}
          description={t('dataProtection.list.noteHint')}
        />
        <Button
          className="react-aria-Button"
          type="submit"
          isPending={add.isPending}
        >
          {t('dataProtection.list.add')}
        </Button>
      </form>
      {justAdded !== null && (
        <p>
          {t('dataProtection.list.added', { value: justAdded })}{' '}
          <Button
            className="react-aria-Button tcp-button--outline"
            onPress={() => {
              onSearchFor(justAdded);
              setJustAdded(null);
            }}
          >
            {t('dataProtection.list.searchFor', { value: justAdded })}
          </Button>
        </p>
      )}

      {list.isPending ? (
        <LoadingState label={t('dataProtection.list.loading')} />
      ) : list.isError ? (
        <ErrorState
          message={t('dataProtection.list.error')}
          channel={RECORDS_CHANNEL}
          onRetry={() => void list.refetch()}
        />
      ) : rows.length === 0 ? (
        <p>{t('dataProtection.list.empty')}</p>
      ) : (
        <>
          <div className="data-protection__search">
            <TextField
              label={t('dataProtection.list.filter')}
              value={filter}
              onChange={setFilter}
            />
            <RoundIconButton
              icon={Trash2}
              label={tCount('dataProtection.list.remove', selected.length)}
              outline
              isDisabled={selected.length === 0}
              onPress={() => setConfirming(true)}
            />
          </div>
          <p id={usageId} className="visually-hidden">
            {t('records.usage')}
          </p>
          <Suspense fallback={<LoadingState label={t('records.loading')} />}>
            <RecordSheet
              table="do-not-store"
              label={t('dataProtection.list.sheet')}
              definition={LIST_DEFINITION}
              rows={rows}
              editedCells={NO_MARKS}
              addedRows={NO_MARKS}
              onEdit={onEdit}
              onFocusRow={() => undefined}
              onUndoKey={() => undefined}
              describedBy={usageId}
              onSelectionChange={setSelected}
              readOnlyFields={READ_ONLY}
              quickFilter={filter}
            />
          </Suspense>
        </>
      )}

      <ConfirmDialog
        isOpen={confirming}
        heading={t('dataProtection.list.remove.heading')}
        message={t('dataProtection.list.remove.message')}
        confirmLabel={t('dataProtection.list.remove.confirm')}
        onConfirm={() => void confirmRemove()}
        onCancel={() => setConfirming(false)}
      />
    </section>
  );
};
