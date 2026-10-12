import { useCallback, useState, type ReactNode } from 'react';
import { ApiError, recordErrorBody } from '../../api/errors';
import { t } from '../../strings';
import { ConfirmDialog } from '../Dialog/ConfirmDialog';
import { announceRecords } from './announceRecords';

/** One save, told whether the person has confirmed storing a do-not-store match. */
export type GuardedSave<T> = (confirmDoNotStore: boolean) => Promise<T>;

/**
 * Warn-and-allow for people's own edits (001.04). A save is tried as it is;
 * if the server refuses it with `do_not_store`, the person is asked whether to
 * store it anyway, naming the matching fields, and the save is tried once
 * more only if they say yes. Agents get no such choice: their writes are
 * simply refused.
 *
 * `guard` resolves to the save's result, or `undefined` when the person
 * chose not to store it. Any other failure is thrown as before. Render
 * `dialog` once, where the caller renders its other dialogs.
 */
export const useDoNotStoreGuard = (
  portalContainer?: Element,
): {
  guard: <T>(save: GuardedSave<T>) => Promise<T | undefined>;
  dialog: ReactNode;
} => {
  const [asking, setAsking] = useState<{
    fields: readonly string[];
    answer: (store: boolean) => void;
  } | null>(null);

  const guard = useCallback(
    async <T,>(save: GuardedSave<T>): Promise<T | undefined> => {
      try {
        return await save(false);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        const body = recordErrorBody(error);
        if (body.code !== 'do_not_store') throw error;
        const store = await new Promise<boolean>((answer) => {
          setAsking({ fields: body.fields, answer });
        });
        setAsking(null);
        if (!store) {
          announceRecords('records.announce.doNotStoreKept');
          return undefined;
        }
        return save(true);
      }
    },
    [],
  );

  const dialog = (
    <ConfirmDialog
      isOpen={asking !== null}
      heading={t('records.doNotStore.heading')}
      message={t('records.doNotStore.message', {
        fields: asking?.fields.join(', ') ?? '',
      })}
      confirmLabel={t('records.doNotStore.confirm')}
      portalContainer={portalContainer}
      onConfirm={() => asking?.answer(true)}
      onCancel={() => asking?.answer(false)}
    />
  );

  return { guard, dialog };
};
