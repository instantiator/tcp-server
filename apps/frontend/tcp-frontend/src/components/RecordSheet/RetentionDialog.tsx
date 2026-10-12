import { fieldOrder } from '@tcp/shared/client';
import { useState, type SubmitEvent } from 'react';
import {
  Button,
  Label,
  RadioButton,
  RadioField,
  RadioGroup,
} from 'react-aria-components';
import { ApiError } from '../../api/errors';
import type { RecordTableDefinition } from '../../api/dtos';
import { useSetRetention } from '../../api/hooks';
import { t } from '../../strings';
import { ButtonRow } from '../ButtonRow/ButtonRow';
import { Dialog } from '../Dialog/Dialog';
import { TextField } from '../Field/TextField';
import { announceRecords } from './announceRecords';

/** The radio value for "keep rows until someone deletes them". */
const NEVER = '';
const MAX_DAYS = 36_500;

/** A table's date fields: the only ones a retention clock can start from. */
const dateFields = (definition: RecordTableDefinition): string[] =>
  fieldOrder(definition).filter((field) => {
    const schema = definition.schema.properties[field];
    return (
      schema.type === 'string' &&
      (schema.format === 'date' || schema.format === 'date-time')
    );
  });

export interface RetentionDialogProps {
  readonly companyId: string;
  readonly definition: RecordTableDefinition;
  readonly onClose: () => void;
  readonly portalContainer?: Element | undefined;
}

/**
 * Sets how long a table keeps its rows (001.04): never deleted, or a number
 * of days after their last change or after one of the table's date fields.
 * A radio group, since the choices are few and all worth seeing.
 */
export const RetentionDialog = ({
  companyId,
  definition,
  onClose,
  portalContainer,
}: RetentionDialogProps) => {
  const table = definition.name;
  const set = useSetRetention(companyId, table);
  const [from, setFrom] = useState(definition.retention?.from ?? NEVER);
  const [days, setDays] = useState(String(definition.retention?.days ?? ''));
  const [daysError, setDaysError] = useState<string | undefined>();
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const count = Number(days);
    if (
      from !== NEVER &&
      !(Number.isInteger(count) && count >= 1 && count <= MAX_DAYS)
    ) {
      setDaysError(t('records.retention.daysInvalid'));
      return;
    }
    try {
      await set.mutateAsync(from === NEVER ? null : { days: count, from });
      announceRecords('records.announce.retentionSet', { table });
      onClose();
    } catch (error) {
      setProblem(
        error instanceof ApiError ? error.message : t('records.error.generic'),
      );
    }
  };

  return (
    <Dialog
      heading={t('records.retention.heading', { table })}
      portalContainer={portalContainer}
      onClose={onClose}
    >
      <form onSubmit={(event) => void submit(event)}>
        <RadioGroup
          className="react-aria-RadioGroup"
          value={from}
          onChange={(value) => {
            setFrom(value);
            setDaysError(undefined);
          }}
        >
          <Label>{t('records.retention.when')}</Label>
          <RadioField value={NEVER}>
            <RadioButton>{t('records.retention.never')}</RadioButton>
          </RadioField>
          <RadioField value="updated">
            <RadioButton>{t('records.retention.fromUpdated')}</RadioButton>
          </RadioField>
          {dateFields(definition).map((field) => (
            <RadioField key={field} value={field}>
              <RadioButton>
                {t('records.retention.fromField', { field })}
              </RadioButton>
            </RadioField>
          ))}
        </RadioGroup>
        {from !== NEVER && (
          <TextField
            label={t('records.retention.days')}
            value={days}
            onChange={(value) => {
              setDays(value);
              setDaysError(undefined);
            }}
            description={t('records.retention.daysHint')}
            errorMessage={daysError}
            isRequired
          />
        )}
        <p>{t('records.retention.note')}</p>
        {problem !== null && <p className="tcp-field__error">{problem}</p>}
        <ButtonRow>
          <Button
            className="react-aria-Button"
            type="submit"
            isPending={set.isPending}
          >
            {t('records.retention.save')}
          </Button>
          <Button
            className="react-aria-Button tcp-button--outline"
            onPress={onClose}
          >
            {t('records.retention.cancel')}
          </Button>
        </ButtonRow>
      </form>
    </Dialog>
  );
};
