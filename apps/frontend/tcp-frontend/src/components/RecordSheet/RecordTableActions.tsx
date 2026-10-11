import { MoreHorizontal } from 'lucide-react';
import { useId, useState, type SubmitEvent } from 'react';
import {
  Button,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
  type Key,
} from 'react-aria-components';
import { ApiError, recordErrorBody } from '../../api/errors';
import {
  downloadRecordTableCsv,
  useAppendRecordsCsv,
  useClearRecordTable,
  useDropRecordTable,
} from '../../api/hooks';
import { t, tCount } from '../../strings';
import { ButtonRow } from '../ButtonRow/ButtonRow';
import { Dialog } from '../Dialog/Dialog';
import { Icon, WithTooltip } from '../Icon/Icon';
import { announceRecords } from './announceRecords';

export interface RecordTableActionsProps {
  readonly companyId: string;
  readonly companySlug: string;
  readonly table: string;
  /** How many records the table holds, for the confirmations. */
  readonly records: number;
  /** Adds "Reload" to the menu, for a view showing the table's rows. */
  readonly onReload?: () => void;
  /** Called once the table is deleted, so the caller can move focus somewhere stable. */
  readonly onDropped?: () => void;
  readonly portalContainer?: Element | undefined;
}

type Open = 'append' | 'clear' | 'drop' | null;

/**
 * The less common things to do to a whole table — append a CSV, clear it,
 * delete it — behind one "More actions" menu, so the destructive ones sit
 * apart from the everyday buttons. Used by the office tray's rows and by the
 * sheet's title bar. Clearing and deleting ask first, and offer a download of
 * the table before it goes.
 */
export const RecordTableActions = ({
  companyId,
  companySlug,
  table,
  records,
  onReload,
  onDropped,
  portalContainer,
}: RecordTableActionsProps) => {
  const [open, setOpen] = useState<Open>(null);
  const clear = useClearRecordTable(companyId, table);
  const drop = useDropRecordTable(companyId, table);
  const label = t('records.more', { table });

  const onAction = (key: Key) => {
    if (key === 'reload') {
      onReload?.();
      announceRecords('records.announce.reloaded', { table });
    } else {
      setOpen(
        key === 'append' || key === 'clear' || key === 'drop' ? key : null,
      );
    }
  };

  const confirm = async () => {
    const dropping = open === 'drop';
    try {
      await (dropping ? drop : clear).mutateAsync();
      setOpen(null);
      announceRecords(
        dropping ? 'records.announce.dropped' : 'records.announce.cleared',
        { table },
      );
      if (dropping) onDropped?.();
    } catch (error) {
      announceRecords('records.announce.notSaved', {
        message:
          error instanceof ApiError
            ? error.message
            : t('records.error.generic'),
      });
    }
  };

  return (
    <>
      <MenuTrigger>
        <WithTooltip label={label} portalContainer={portalContainer}>
          <Button
            className="react-aria-Button tcp-icon-button tcp-icon-button--small tcp-button--outline"
            aria-label={label}
          >
            <Icon icon={MoreHorizontal} />
          </Button>
        </WithTooltip>
        {/* eslint-disable-next-line @typescript-eslint/no-deprecated -- deliberate; see `WithTooltip` */}
        <Popover UNSTABLE_portalContainer={portalContainer}>
          <Menu onAction={onAction}>
            <MenuItem id="append">{t('records.action.append')}</MenuItem>
            {onReload !== undefined && (
              <MenuItem id="reload">{t('records.action.reload')}</MenuItem>
            )}
            <MenuItem id="clear">{t('records.action.clear')}</MenuItem>
            <MenuItem id="drop">{t('records.action.drop')}</MenuItem>
          </Menu>
        </Popover>
      </MenuTrigger>

      {open === 'append' && (
        <AppendCsvDialog
          companyId={companyId}
          table={table}
          portalContainer={portalContainer}
          onClose={() => setOpen(null)}
        />
      )}

      {(open === 'clear' || open === 'drop') && (
        <Dialog
          confirmation
          heading={t(
            open === 'clear' ? 'records.clear.heading' : 'records.drop.heading',
            { table },
          )}
          portalContainer={portalContainer}
          onClose={() => setOpen(null)}
        >
          <p>
            {tCount(
              open === 'clear'
                ? 'records.clear.message'
                : 'records.drop.message',
              records,
            )}
          </p>
          <ButtonRow>
            <Button
              className="react-aria-Button"
              isPending={clear.isPending || drop.isPending}
              onPress={() => void confirm()}
            >
              {t(
                open === 'clear'
                  ? 'records.clear.confirm'
                  : 'records.drop.confirm',
              )}
            </Button>
            <Button
              className="react-aria-Button tcp-button--outline"
              onPress={() =>
                void downloadRecordTableCsv(
                  companyId,
                  companySlug,
                  table,
                ).catch(() => announceRecords('records.downloadFailed'))
              }
            >
              {t('records.downloadFirst')}
            </Button>
            <Button
              className="react-aria-Button tcp-button--outline"
              // Inside a modal that just opened, not on page load, which is
              // what the rule guards against: focus lands on the safe answer.
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              onPress={() => setOpen(null)}
            >
              {t('confirm.no')}
            </Button>
          </ButtonRow>
        </Dialog>
      )}
    </>
  );
};

/**
 * Appends a CSV file's rows to a table, all or none. The rows that stop it
 * are listed by their spreadsheet row number, in the dialog, so they can be
 * fixed and the file tried again.
 */
const AppendCsvDialog = ({
  companyId,
  table,
  portalContainer,
  onClose,
}: {
  readonly companyId: string;
  readonly table: string;
  readonly portalContainer?: Element | undefined;
  readonly onClose: () => void;
}) => {
  const append = useAppendRecordsCsv(companyId, table);
  const inputId = useId();
  const errorsId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<
    readonly { row: number; message: string }[]
  >([]);

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (file === null) {
      setProblem(t('records.append.noFile'));
      return;
    }
    try {
      const result = await append.mutateAsync(file);
      announceRecords('records.announce.appended', {
        table,
        inserted: result.inserted,
        skipped: result.alreadyExists,
      });
      onClose();
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const { errors } = recordErrorBody(error);
      setRowErrors(errors);
      setProblem(
        errors.length > 0
          ? t('records.append.errors')
          : error.status === 413
            ? t('records.append.tooBig')
            : error.message,
      );
    }
  };

  return (
    <Dialog
      heading={t('records.append.heading', { table })}
      portalContainer={portalContainer}
      onClose={onClose}
    >
      <form onSubmit={(event) => void submit(event)}>
        {/* ponytail: the native file input, as in CreateTaskDialog, for the same reasons given there. */}
        <label className="tcp-field__label" htmlFor={inputId}>
          {t('records.append.file')}
          {/* eslint-disable-next-line jsx-a11y/control-has-associated-label -- labelled by nesting and htmlFor; `t()` is not a literal the rule can read */}
          <input
            id={inputId}
            type="file"
            accept=".csv,text/csv"
            aria-describedby={problem === null ? undefined : errorsId}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setProblem(null);
              setRowErrors([]);
            }}
          />
        </label>
        {problem !== null && (
          <div id={errorsId} className="tcp-field__error">
            <p>{problem}</p>
            {rowErrors.length > 0 && (
              <ul>
                {rowErrors.map((e) => (
                  <li key={e.row}>
                    {t('records.append.errorRow', {
                      row: e.row,
                      message: e.message,
                    })}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <ButtonRow>
          <Button
            className="react-aria-Button"
            type="submit"
            isPending={append.isPending}
          >
            {t('records.append.submit')}
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
