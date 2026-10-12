import { fieldOrder } from '@tcp/shared/client';
import { createRef, useMemo, useState, type SubmitEvent } from 'react';
import { Button } from 'react-aria-components';
import { ApiError, recordErrorBody } from '../../api/errors';
import type { RecordTableDefinition, TimedRecord } from '../../api/dtos';
import { useAddRecord } from '../../api/hooks';
import { t, type StringKey } from '../../strings';
import { ButtonRow } from '../ButtonRow/ButtonRow';
import { Dialog } from '../Dialog/Dialog';
import { TextField } from '../Field/TextField';
import { focusFirstInvalid } from '../Field/focusFirstInvalid';
import { parseFieldInput } from './fieldInput';

export interface AddRowDialogProps {
  readonly companyId: string;
  readonly definition: RecordTableDefinition;
  readonly onAdded: (row: TimedRecord) => void;
  readonly onClose: () => void;
  readonly portalContainer?: Element | undefined;
}

/**
 * A form for one new record: a labelled field per column, in the sheet's
 * order. Each field's problem is shown on that field and focus moves to the
 * first one, so a failed submit says which field is wrong (ADR-026). A key
 * that is already taken is reported on the key's first field.
 */
export const AddRowDialog = ({
  companyId,
  definition,
  onAdded,
  onClose,
  portalContainer,
}: AddRowDialogProps) => {
  const add = useAddRecord(companyId, definition.name);
  const fields = useMemo(() => fieldOrder(definition), [definition]);
  const refs = useMemo(
    () => new Map(fields.map((f) => [f, createRef<HTMLElement>()])),
    [fields],
  );
  const required = new Set(definition.schema.required ?? []);
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [problem, setProblem] = useState<string | null>(null);

  const showErrors = (found: Record<string, string>) => {
    setErrors(found);
    focusFirstInvalid(
      fields.map((f) => ({
        error: found[f],
        ref: refs.get(f) ?? createRef<HTMLElement>(),
      })),
    );
  };

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data: Record<string, unknown> = {};
    const found: Record<string, string> = {};
    for (const field of fields) {
      const parsed = parseFieldInput(
        definition.schema.properties[field],
        values[field] ?? '',
      );
      if ('error' in parsed) found[field] = t(parsed.error);
      else if (parsed.value === null) {
        if (required.has(field)) found[field] = t('records.addRow.required');
      } else data[field] = parsed.value;
    }
    if (Object.keys(found).length > 0) {
      showErrors(found);
      return;
    }
    try {
      onAdded(await add.mutateAsync({ data }));
      onClose();
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (recordErrorBody(error).code === 'conflict') {
        showErrors({
          [definition.primaryKey[0] ?? fields[0]]: t('records.addRow.clash'),
        });
      } else {
        // The server's reason, e.g. a date in the wrong format.
        setProblem(error.message);
      }
    }
  };

  const hint = (field: string): StringKey | undefined => {
    const schema = definition.schema.properties[field];
    if (schema.type === 'boolean') return 'records.addRow.hint.boolean';
    if (schema.format === 'date') return 'records.addRow.hint.date';
    return undefined;
  };

  return (
    <Dialog
      heading={t('records.addRow.heading', { table: definition.name })}
      portalContainer={portalContainer}
      onClose={onClose}
    >
      <form onSubmit={(event) => void submit(event)}>
        {fields.map((field) => {
          const hintKey = hint(field);
          return (
            <TextField
              key={field}
              label={field}
              value={values[field] ?? ''}
              onChange={(value) => {
                setValues((v) => ({ ...v, [field]: value }));
                setErrors((previous) => {
                  const next = { ...previous };
                  delete next[field];
                  return next;
                });
              }}
              isRequired={required.has(field)}
              description={
                definition.schema.properties[field].description ??
                (hintKey === undefined ? undefined : t(hintKey))
              }
              errorMessage={errors[field]}
              inputRef={refs.get(field)}
            />
          );
        })}
        {problem !== null && <p className="tcp-field__error">{problem}</p>}
        <ButtonRow>
          <Button
            className="react-aria-Button"
            type="submit"
            isPending={add.isPending}
          >
            {t('records.addRow.submit')}
          </Button>
          <Button
            className="react-aria-Button tcp-button--outline"
            onPress={onClose}
          >
            {t('records.append.cancel')}
          </Button>
        </ButtonRow>
      </form>
    </Dialog>
  );
};
