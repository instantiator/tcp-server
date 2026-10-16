import { fieldOrder } from '@tcp/shared/client';
import { useEffect, useId, useRef, useState, type SubmitEvent } from 'react';
import {
  Button,
  CheckboxButton,
  CheckboxField,
  CheckboxGroup,
  Label,
  RadioButton,
  RadioField,
  RadioGroup,
} from 'react-aria-components';
import type { RecordFieldSchema, RecordTableDefinition } from '../../api/dtos';
import { ApiError, recordErrorBody } from '../../api/errors';
import {
  downloadRecordTableCsv,
  useAddColumn,
  useAddUniqueKey,
  useDeleteColumn,
  useDropUniqueKey,
  useRenameColumn,
  useRetypeColumn,
  useSetPrimaryKey,
} from '../../api/hooks';
import { t, tCount, type StringKey } from '../../strings';
import { ButtonRow } from '../ButtonRow/ButtonRow';
import { Dialog } from '../Dialog/Dialog';
import { TextField } from '../Field/TextField';
import { announceRecords } from './announceRecords';
import { parseFieldInput } from './fieldInput';
import { useDoNotStoreGuard } from './useDoNotStoreGuard';
import './ColumnsDialog.css';

/** Focus for a form that has just replaced the list, inside the dialog. */
const useFocusOnMount = () => {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => ref.current?.focus(), []);
  return ref;
};

/** A default the API can carry: what `parseFieldInput` gives for a scalar column. */
const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean';

/** The column types a person picks from, in words, and what each stores. */
const TYPES = [
  {
    id: 'text',
    label: 'records.columns.type.text',
    schema: { type: 'string' },
  },
  {
    id: 'number',
    label: 'records.columns.type.number',
    schema: { type: 'number' },
  },
  {
    id: 'integer',
    label: 'records.columns.type.integer',
    schema: { type: 'integer' },
  },
  {
    id: 'boolean',
    label: 'records.columns.type.boolean',
    schema: { type: 'boolean' },
  },
  {
    id: 'date',
    label: 'records.columns.type.date',
    schema: { type: 'string', format: 'date' },
  },
] as const satisfies readonly {
  id: string;
  label: StringKey;
  schema: RecordFieldSchema;
}[];

type TypeId = (typeof TYPES)[number]['id'];

/** The type choice with `id`. */
const typeById = (id: TypeId) =>
  TYPES.find((type) => type.id === id) ?? TYPES[0];

/** The add form's choice matching a column's schema, if any. */
const typeOf = (schema: RecordFieldSchema) =>
  TYPES.find(
    (type) =>
      type.schema.type === schema.type &&
      ('format' in type.schema ? type.schema.format : undefined) ===
        (schema.format === 'date' ? 'date' : undefined),
  );

/** A column's type in words, as the add form names it. */
const typeWords = (schema: RecordFieldSchema): string => {
  const match = typeOf(schema);
  return match === undefined ? schema.type : t(match.label);
};

/** The type choices as radio buttons, labelled by `label`. */
const TypeChoice = ({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: TypeId;
  readonly onChange: (value: TypeId) => void;
}) => (
  <RadioGroup
    className="react-aria-RadioGroup"
    value={value}
    onChange={(chosen) => {
      const next = TYPES.find((option) => option.id === chosen);
      if (next !== undefined) onChange(next.id);
    }}
  >
    <Label>{label}</Label>
    {TYPES.map((option) => (
      <RadioField key={option.id} value={option.id}>
        <RadioButton>{t(option.label)}</RadioButton>
      </RadioField>
    ))}
  </RadioGroup>
);

/** Key fields must compare exactly: text or whole numbers only. */
const canBeKey = (schema: RecordFieldSchema): boolean =>
  schema.type === 'integer' ||
  (schema.type === 'string' && schema.format !== 'date-time');

/** What the dialog is showing: the list, or one change in progress. */
type View =
  | { kind: 'list' }
  | { kind: 'add' }
  | { kind: 'rename'; column: string }
  | { kind: 'delete'; column: string }
  | { kind: 'key' }
  | { kind: 'retype'; column: string }
  | { kind: 'blank'; column: string; type: TypeId; message: string }
  | { kind: 'uniqueAdd' }
  | { kind: 'uniqueDrop'; fields: readonly string[] };

export interface ColumnsDialogProps {
  readonly companyId: string;
  readonly companySlug: string;
  readonly definition: RecordTableDefinition;
  /** How many records the table holds: a required column needs a default unless there are none. */
  readonly records: number;
  readonly onClose: () => void;
  /** After a change has been made, before the dialog closes. */
  readonly onChanged?: () => void;
  readonly portalContainer?: Element | undefined;
}

/**
 * Adds, renames and deletes a table's columns, and changes its key (001.06).
 * One list of columns, each with its own Rename and Delete, so every action
 * names the column it acts on. A change closes the dialog and is announced;
 * focus goes back to the menu that opened it, the one stable place, rather
 * than into a list that has just changed under it (ADR-027).
 *
 * A key column can't be deleted, and says why in words beside the disabled
 * button, not just by being disabled. Deleting asks first, and offers a
 * download of the table, as clearing a table does.
 */
export const ColumnsDialog = ({
  companyId,
  companySlug,
  definition,
  records,
  onClose,
  onChanged,
  portalContainer,
}: ColumnsDialogProps) => {
  const table = definition.name;
  const [view, setView] = useState<View>({ kind: 'list' });
  const toList = () => setView({ kind: 'list' });
  const done = (key: StringKey, params: Record<string, string>) => {
    onChanged?.();
    announceRecords(key, { table, ...params });
    onClose();
  };

  if (view.kind === 'blank') {
    return (
      <BlankValues
        companyId={companyId}
        companySlug={companySlug}
        table={table}
        column={view.column}
        type={view.type}
        message={view.message}
        portalContainer={portalContainer}
        onCancel={toList}
        onDone={() =>
          done('records.announce.columnRetyped', {
            column: view.column,
            type: t(typeById(view.type).label),
          })
        }
      />
    );
  }

  if (view.kind === 'uniqueDrop') {
    return (
      <DropUniqueKey
        companyId={companyId}
        table={table}
        fields={view.fields}
        portalContainer={portalContainer}
        onCancel={toList}
        onDone={() =>
          done('records.announce.uniqueKeyDropped', {
            fields: view.fields.join(', '),
          })
        }
      />
    );
  }

  if (view.kind === 'delete') {
    return (
      <DeleteColumn
        companyId={companyId}
        companySlug={companySlug}
        table={table}
        column={view.column}
        records={records}
        portalContainer={portalContainer}
        onCancel={toList}
        onDone={() =>
          done('records.announce.columnDeleted', { column: view.column })
        }
      />
    );
  }

  return (
    <Dialog
      heading={t('records.columns.heading', { table })}
      portalContainer={portalContainer}
      onClose={onClose}
    >
      {view.kind === 'list' && (
        <ColumnList
          definition={definition}
          onAdd={() => setView({ kind: 'add' })}
          onRename={(column) => setView({ kind: 'rename', column })}
          onDelete={(column) => setView({ kind: 'delete', column })}
          onKey={() => setView({ kind: 'key' })}
          onRetype={(column) => setView({ kind: 'retype', column })}
          onAddUnique={() => setView({ kind: 'uniqueAdd' })}
          onDropUnique={(fields) => setView({ kind: 'uniqueDrop', fields })}
          onClose={onClose}
        />
      )}
      {view.kind === 'add' && (
        <AddColumn
          companyId={companyId}
          definition={definition}
          records={records}
          portalContainer={portalContainer}
          onCancel={toList}
          onDone={(column) => done('records.announce.columnAdded', { column })}
        />
      )}
      {view.kind === 'rename' && (
        <RenameColumn
          companyId={companyId}
          table={table}
          column={view.column}
          onCancel={toList}
          onDone={(newName) =>
            done('records.announce.columnRenamed', {
              column: view.column,
              newName,
            })
          }
        />
      )}
      {view.kind === 'key' && (
        <ChangeKey
          companyId={companyId}
          definition={definition}
          onCancel={toList}
          onDone={(fields) =>
            done('records.announce.keyChanged', { fields: fields.join(', ') })
          }
        />
      )}
      {view.kind === 'uniqueAdd' && (
        <AddUniqueKey
          companyId={companyId}
          definition={definition}
          onCancel={toList}
          onDone={(fields) =>
            done('records.announce.uniqueKeyAdded', {
              fields: fields.join(', '),
            })
          }
        />
      )}
      {view.kind === 'retype' && (
        <RetypeColumn
          companyId={companyId}
          definition={definition}
          column={view.column}
          onCancel={toList}
          onUnconvertible={(type, message) =>
            setView({ kind: 'blank', column: view.column, type, message })
          }
          onDone={(type) =>
            done('records.announce.columnRetyped', {
              column: view.column,
              type: t(typeById(type).label),
            })
          }
        />
      )}
    </Dialog>
  );
};

/** Every column, in the sheet's order, with what can be done to each. */
const ColumnList = ({
  definition,
  onAdd,
  onRename,
  onDelete,
  onKey,
  onRetype,
  onAddUnique,
  onDropUnique,
  onClose,
}: {
  readonly definition: RecordTableDefinition;
  readonly onAdd: () => void;
  readonly onRename: (column: string) => void;
  readonly onDelete: (column: string) => void;
  readonly onKey: () => void;
  readonly onRetype: (column: string) => void;
  readonly onAddUnique: () => void;
  readonly onDropUnique: (fields: readonly string[]) => void;
  readonly onClose: () => void;
}) => {
  const idBase = useId();
  const keyFields = new Set([
    ...definition.primaryKey,
    ...definition.uniqueKeys.flat(),
  ]);
  const required = new Set(definition.schema.required ?? []);
  return (
    <>
      <p>
        {t('records.columns.key', { fields: definition.primaryKey.join(', ') })}
      </p>
      <ul className="columns-dialog__list">
        {fieldOrder(definition).map((field, i) => {
          const schema = definition.schema.properties[field];
          const inKey = keyFields.has(field);
          const reasonId = `${idBase}-${i}`;
          return (
            <li key={field} className="columns-dialog__column">
              <span className="columns-dialog__name">{field}</span>{' '}
              <span className="columns-dialog__about">
                {[
                  typeWords(schema),
                  definition.primaryKey.includes(field)
                    ? t('records.columns.inKey')
                    : null,
                  required.has(field) ? t('records.columns.required') : null,
                ]
                  .filter((part) => part !== null)
                  .join(', ')}
              </span>
              <span className="columns-dialog__actions">
                <Button
                  className="react-aria-Button tcp-button--outline"
                  aria-label={t('records.columns.rename', { column: field })}
                  onPress={() => onRename(field)}
                >
                  {t('records.columns.renameShort')}
                </Button>
                <Button
                  className="react-aria-Button tcp-button--outline"
                  aria-label={t('records.columns.retype', { column: field })}
                  onPress={() => onRetype(field)}
                >
                  {t('records.columns.retypeShort')}
                </Button>
                <Button
                  className="react-aria-Button tcp-button--outline"
                  aria-label={t('records.columns.delete', { column: field })}
                  aria-describedby={inKey ? reasonId : undefined}
                  isDisabled={inKey}
                  onPress={() => onDelete(field)}
                >
                  {t('records.columns.deleteShort')}
                </Button>
              </span>
              {inKey && (
                <p id={reasonId} className="columns-dialog__reason">
                  {t('records.columns.keyNoDelete')}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {definition.uniqueKeys.length > 0 && (
        <>
          <p>{t('records.columns.uniqueKeys')}</p>
          <ul className="columns-dialog__list">
            {definition.uniqueKeys.map((fields) => {
              const named = fields.join(', ');
              return (
                <li key={named} className="columns-dialog__column">
                  <span className="columns-dialog__name">{named}</span>
                  <span className="columns-dialog__actions">
                    <Button
                      className="react-aria-Button tcp-button--outline"
                      aria-label={t('records.columns.dropUnique', {
                        fields: named,
                      })}
                      onPress={() => onDropUnique(fields)}
                    >
                      {t('records.columns.dropUniqueShort')}
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <ButtonRow>
        <Button className="react-aria-Button" onPress={onAdd}>
          {t('records.columns.add')}
        </Button>
        <Button
          className="react-aria-Button tcp-button--outline"
          onPress={onKey}
        >
          {t('records.columns.changeKey')}
        </Button>
        <Button
          className="react-aria-Button tcp-button--outline"
          onPress={onAddUnique}
        >
          {t('records.columns.addUnique')}
        </Button>
        <Button
          className="react-aria-Button tcp-button--outline"
          onPress={onClose}
        >
          {t('records.columns.close')}
        </Button>
      </ButtonRow>
    </>
  );
};

/** The message a failed change shows: the server's own words when it gave some. */
const problemOf = (error: unknown): string =>
  error instanceof ApiError ? error.message : t('records.error.generic');

/** Adds a column: its name, type, an optional value for every row, and whether it is required. */
const AddColumn = ({
  companyId,
  definition,
  records,
  portalContainer,
  onCancel,
  onDone,
}: {
  readonly companyId: string;
  readonly definition: RecordTableDefinition;
  readonly records: number;
  readonly portalContainer?: Element | undefined;
  readonly onCancel: () => void;
  readonly onDone: (column: string) => void;
}) => {
  const add = useAddColumn(companyId, definition.name);
  const { guard, dialog } = useDoNotStoreGuard(portalContainer);
  const [column, setColumn] = useState('');
  const [typeId, setTypeId] = useState<TypeId>('text');
  const [fallback, setFallback] = useState('');
  const [required, setRequired] = useState(false);
  const [nameError, setNameError] = useState<string | undefined>();
  const [defaultError, setDefaultError] = useState<string | undefined>();
  const [problem, setProblem] = useState<string | null>(null);
  const nameRef = useFocusOnMount();
  const type = TYPES.find((option) => option.id === typeId) ?? TYPES[0];
  const hasDefault = fallback.trim() !== '';
  const canRequire = hasDefault || records === 0;

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setProblem(null);
    const name = column.trim();
    if (name === '') {
      setNameError(t('records.columns.nameMissing'));
      return;
    }
    const parsed = parseFieldInput(type.schema, fallback);
    if ('error' in parsed) {
      setDefaultError(t(parsed.error));
      return;
    }
    try {
      const saved = await guard((confirmDoNotStore) =>
        add.mutateAsync({
          column: name,
          type: type.schema.type,
          ...('format' in type.schema ? { format: type.schema.format } : {}),
          ...(isScalar(parsed.value) ? { default: parsed.value } : {}),
          required: required && canRequire,
          confirmDoNotStore,
        }),
      );
      if (saved !== undefined) onDone(name);
    } catch (error) {
      // A bad or taken name is the usual refusal: say it beside the name.
      if (error instanceof ApiError && error.status !== 409) {
        setNameError(error.message);
      } else {
        setProblem(problemOf(error));
      }
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)}>
      <TextField
        label={t('records.columns.name')}
        value={column}
        onChange={(value) => {
          setColumn(value);
          setNameError(undefined);
        }}
        description={t('records.columns.nameHint')}
        errorMessage={nameError}
        isRequired
        inputRef={nameRef}
      />
      <TypeChoice
        label={t('records.columns.type')}
        value={typeId}
        onChange={(next) => {
          setTypeId(next);
          setDefaultError(undefined);
        }}
      />
      <TextField
        label={t('records.columns.default')}
        value={fallback}
        onChange={(value) => {
          setFallback(value);
          setDefaultError(undefined);
        }}
        description={tCount('records.columns.defaultHint', records)}
        errorMessage={defaultError}
      />
      <CheckboxField
        isSelected={required && canRequire}
        isDisabled={!canRequire}
        onChange={setRequired}
      >
        <CheckboxButton>{t('records.columns.requiredLabel')}</CheckboxButton>
      </CheckboxField>
      {!canRequire && (
        <p className="columns-dialog__reason">
          {t('records.columns.requiredHint')}
        </p>
      )}
      {problem !== null && <p className="tcp-field__error">{problem}</p>}
      <ButtonRow>
        <Button
          className="react-aria-Button"
          type="submit"
          isPending={add.isPending}
        >
          {t('records.columns.addSubmit')}
        </Button>
        <Button
          className="react-aria-Button tcp-button--outline"
          onPress={onCancel}
        >
          {t('records.columns.back')}
        </Button>
      </ButtonRow>
      {dialog}
    </form>
  );
};

/** Renames one column; every row is rewritten under the new name. */
const RenameColumn = ({
  companyId,
  table,
  column,
  onCancel,
  onDone,
}: {
  readonly companyId: string;
  readonly table: string;
  readonly column: string;
  readonly onCancel: () => void;
  readonly onDone: (newName: string) => void;
}) => {
  const rename = useRenameColumn(companyId, table);
  const [newName, setNewName] = useState(column);
  const [error, setError] = useState<string | undefined>();
  const nameRef = useFocusOnMount();

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newName.trim();
    try {
      await rename.mutateAsync({ column, newName: name });
      onDone(name);
    } catch (e) {
      setError(problemOf(e));
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)}>
      <TextField
        label={t('records.columns.newName', { column })}
        value={newName}
        onChange={(value) => {
          setNewName(value);
          setError(undefined);
        }}
        description={t('records.columns.nameHint')}
        errorMessage={error}
        isRequired
        inputRef={nameRef}
      />
      <ButtonRow>
        <Button
          className="react-aria-Button"
          type="submit"
          isPending={rename.isPending}
        >
          {t('records.columns.renameSubmit')}
        </Button>
        <Button
          className="react-aria-Button tcp-button--outline"
          onPress={onCancel}
        >
          {t('records.columns.back')}
        </Button>
      </ButtonRow>
    </form>
  );
};

/** The props a key form's caller gives: where it is, and what happens next. */
interface KeyFormProps {
  readonly companyId: string;
  readonly definition: RecordTableDefinition;
  readonly onCancel: () => void;
  readonly onDone: (fields: string[]) => void;
}

/** Chooses the primary key's fields. */
const ChangeKey = (props: KeyFormProps) => (
  <KeyForm
    {...props}
    save={useSetPrimaryKey(props.companyId, props.definition.name)}
    initial={props.definition.primaryKey}
    label={t('records.columns.keyFields')}
    hint={t('records.columns.keyHint')}
    submit={t('records.columns.keySubmit')}
  />
);

/** Chooses the fields of a new unique key. */
const AddUniqueKey = (props: KeyFormProps) => (
  <KeyForm
    {...props}
    save={useAddUniqueKey(props.companyId, props.definition.name)}
    initial={[]}
    label={t('records.columns.uniqueFields')}
    hint={t('records.columns.uniqueHint')}
    submit={t('records.columns.uniqueSubmit')}
  />
);

/**
 * Chooses a key's fields from those that can be one; the server says if
 * records would clash or lack a value.
 */
const KeyForm = ({
  definition,
  onCancel,
  onDone,
  save,
  initial,
  label,
  hint,
  submit: submitLabel,
}: KeyFormProps & {
  readonly save: {
    mutateAsync: (fields: string[]) => Promise<unknown>;
    isPending: boolean;
  };
  readonly initial: readonly string[];
  readonly label: string;
  readonly hint: string;
  readonly submit: string;
}) => {
  const [fields, setFields] = useState<string[]>([...initial]);
  const [problem, setProblem] = useState<string | null>(null);
  const problemId = useId();
  const eligible = fieldOrder(definition).filter((field) =>
    canBeKey(definition.schema.properties[field]),
  );

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Keep the order the sheet shows, not the order they were ticked.
    const key = eligible.filter((field) => fields.includes(field));
    try {
      await save.mutateAsync(key);
      onDone(key);
    } catch (error) {
      setProblem(problemOf(error));
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)}>
      <CheckboxGroup
        className="react-aria-CheckboxGroup"
        value={fields}
        onChange={(value) => {
          setFields(value);
          setProblem(null);
        }}
        // Not `isInvalid`: native validation would then block the next
        // submit until the ticks changed, though the fix may be in the rows.
        aria-describedby={problem !== null ? problemId : undefined}
      >
        <Label>{label}</Label>
        {eligible.map((field) => (
          <CheckboxField key={field} value={field}>
            <CheckboxButton>{field}</CheckboxButton>
          </CheckboxField>
        ))}
      </CheckboxGroup>
      <p>{hint}</p>
      {problem !== null && (
        <p id={problemId} className="tcp-field__error">
          {problem}
        </p>
      )}
      <ButtonRow>
        <Button
          className="react-aria-Button"
          type="submit"
          isDisabled={fields.length === 0}
          isPending={save.isPending}
        >
          {submitLabel}
        </Button>
        <Button
          className="react-aria-Button tcp-button--outline"
          onPress={onCancel}
        >
          {t('records.columns.back')}
        </Button>
      </ButtonRow>
    </form>
  );
};

/** Asks before deleting a column, with a download first, as clearing a table does. */
const DeleteColumn = ({
  companyId,
  companySlug,
  table,
  column,
  records,
  portalContainer,
  onCancel,
  onDone,
}: {
  readonly companyId: string;
  readonly companySlug: string;
  readonly table: string;
  readonly column: string;
  readonly records: number;
  readonly portalContainer?: Element | undefined;
  readonly onCancel: () => void;
  readonly onDone: () => void;
}) => {
  const remove = useDeleteColumn(companyId, table);
  const [problem, setProblem] = useState<string | null>(null);

  const confirm = async () => {
    try {
      await remove.mutateAsync(column);
      onDone();
    } catch (error) {
      setProblem(problemOf(error));
    }
  };

  return (
    <Dialog
      confirmation
      heading={t('records.columns.deleteHeading', { column, table })}
      portalContainer={portalContainer}
      onClose={onCancel}
    >
      <p>{tCount('records.columns.deleteMessage', records)}</p>
      {problem !== null && <p className="tcp-field__error">{problem}</p>}
      <ButtonRow>
        <Button
          className="react-aria-Button"
          isPending={remove.isPending}
          onPress={() => void confirm()}
        >
          {t('records.columns.deleteConfirm')}
        </Button>
        <Button
          className="react-aria-Button tcp-button--outline"
          onPress={() =>
            void downloadRecordTableCsv(companyId, companySlug, table).catch(
              () => announceRecords('records.downloadFailed'),
            )
          }
        >
          {t('records.downloadFirst')}
        </Button>
        <Button
          className="react-aria-Button tcp-button--outline"
          // Inside a modal that just opened: focus lands on the safe answer.
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          onPress={onCancel}
        >
          {t('confirm.no')}
        </Button>
      </ButtonRow>
    </Dialog>
  );
};

/** Changes a column's type; values that won't convert lead to {@link BlankValues}. */
const RetypeColumn = ({
  companyId,
  definition,
  column,
  onCancel,
  onUnconvertible,
  onDone,
}: {
  readonly companyId: string;
  readonly definition: RecordTableDefinition;
  readonly column: string;
  readonly onCancel: () => void;
  readonly onUnconvertible: (type: TypeId, message: string) => void;
  readonly onDone: (type: TypeId) => void;
}) => {
  const retype = useRetypeColumn(companyId, definition.name);
  const current = typeOf(definition.schema.properties[column]);
  const [typeId, setTypeId] = useState<TypeId>(current?.id ?? 'text');
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const { schema } = typeById(typeId);
    try {
      await retype.mutateAsync({
        column,
        type: schema.type,
        ...('format' in schema ? { format: schema.format } : {}),
      });
      onDone(typeId);
    } catch (error) {
      if (
        error instanceof ApiError &&
        recordErrorBody(error).code === 'unconvertible'
      ) {
        onUnconvertible(typeId, error.message);
      } else {
        setProblem(problemOf(error));
      }
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)}>
      <TypeChoice
        label={t('records.columns.retypeLabel', { column })}
        value={typeId}
        onChange={(next) => {
          setTypeId(next);
          setProblem(null);
        }}
      />
      <p>{t('records.columns.retypeHint')}</p>
      {problem !== null && <p className="tcp-field__error">{problem}</p>}
      <ButtonRow>
        <Button
          className="react-aria-Button"
          type="submit"
          isDisabled={typeId === current?.id}
          isPending={retype.isPending}
        >
          {t('records.columns.retypeSubmit')}
        </Button>
        <Button
          className="react-aria-Button tcp-button--outline"
          onPress={onCancel}
        >
          {t('records.columns.back')}
        </Button>
      </ButtonRow>
    </form>
  );
};

/**
 * Asks before a retype blanks the values that won't convert, quoting the
 * server's count and examples, with a download first, as deleting does.
 */
const BlankValues = ({
  companyId,
  companySlug,
  table,
  column,
  type,
  message,
  portalContainer,
  onCancel,
  onDone,
}: {
  readonly companyId: string;
  readonly companySlug: string;
  readonly table: string;
  readonly column: string;
  readonly type: TypeId;
  readonly message: string;
  readonly portalContainer?: Element | undefined;
  readonly onCancel: () => void;
  readonly onDone: () => void;
}) => {
  const retype = useRetypeColumn(companyId, table);
  const [problem, setProblem] = useState<string | null>(null);

  const confirm = async () => {
    const { schema } = typeById(type);
    try {
      await retype.mutateAsync({
        column,
        type: schema.type,
        ...('format' in schema ? { format: schema.format } : {}),
        blankUnconvertible: true,
      });
      onDone();
    } catch (error) {
      setProblem(problemOf(error));
    }
  };

  return (
    <Dialog
      confirmation
      heading={t('records.columns.blankHeading', { column })}
      portalContainer={portalContainer}
      onClose={onCancel}
    >
      <p>{message}</p>
      <p>{t('records.columns.blankMessage')}</p>
      {problem !== null && <p className="tcp-field__error">{problem}</p>}
      <ButtonRow>
        <Button
          className="react-aria-Button"
          isPending={retype.isPending}
          onPress={() => void confirm()}
        >
          {t('records.columns.blankConfirm')}
        </Button>
        <Button
          className="react-aria-Button tcp-button--outline"
          onPress={() =>
            void downloadRecordTableCsv(companyId, companySlug, table).catch(
              () => announceRecords('records.downloadFailed'),
            )
          }
        >
          {t('records.downloadFirst')}
        </Button>
        <Button
          className="react-aria-Button tcp-button--outline"
          // Inside a modal that just opened: focus lands on the safe answer.
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          onPress={onCancel}
        >
          {t('confirm.no')}
        </Button>
      </ButtonRow>
    </Dialog>
  );
};

/** Asks before dropping a unique key, which lets the same thing be recorded twice. */
const DropUniqueKey = ({
  companyId,
  table,
  fields,
  portalContainer,
  onCancel,
  onDone,
}: {
  readonly companyId: string;
  readonly table: string;
  readonly fields: readonly string[];
  readonly portalContainer?: Element | undefined;
  readonly onCancel: () => void;
  readonly onDone: () => void;
}) => {
  const drop = useDropUniqueKey(companyId, table);
  const [problem, setProblem] = useState<string | null>(null);
  const named = fields.join(', ');

  const confirm = async () => {
    try {
      await drop.mutateAsync(fields);
      onDone();
    } catch (error) {
      setProblem(problemOf(error));
    }
  };

  return (
    <Dialog
      confirmation
      heading={t('records.columns.dropUniqueHeading', { fields: named })}
      portalContainer={portalContainer}
      onClose={onCancel}
    >
      <p>{t('records.columns.dropUniqueMessage', { fields: named })}</p>
      {problem !== null && <p className="tcp-field__error">{problem}</p>}
      <ButtonRow>
        <Button
          className="react-aria-Button"
          isPending={drop.isPending}
          onPress={() => void confirm()}
        >
          {t('records.columns.dropUniqueConfirm')}
        </Button>
        <Button
          className="react-aria-Button tcp-button--outline"
          // Inside a modal that just opened: focus lands on the safe answer.
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          onPress={onCancel}
        >
          {t('confirm.no')}
        </Button>
      </ButtonRow>
    </Dialog>
  );
};
