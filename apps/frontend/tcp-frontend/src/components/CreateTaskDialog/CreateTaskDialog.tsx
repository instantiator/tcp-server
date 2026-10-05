import type { RefObject, SubmitEvent } from 'react';
import { useId, useRef, useState } from 'react';
import { Button, CheckboxButton, CheckboxField } from 'react-aria-components';
import { ANNOUNCE_IMMEDIATE_MS, announce } from '../../announce/announcer';
import { ApiError } from '../../api/errors';
import {
  useCompanyRolesList,
  useCreateTask,
  useLiveSpendOverview,
} from '../../api/hooks';
import { t, type StringKey } from '../../strings';
import { Dialog } from '../Dialog/Dialog';
import { ErrorState } from '../ErrorState/ErrorState';
import { focusFirstInvalid } from '../Field/focusFirstInvalid';
import { TextField } from '../Field/TextField';
import './CreateTaskDialog.css';

export interface CreateTaskDialogProps {
  readonly companyId: string;
  readonly onClose: () => void;
}

/**
 * Chosen in the planner-role picker to mean "no preference" —
 * `plannerRoleId` is left unset rather than sent as this value. Role ids are
 * server-issued UUIDs, so a short literal cannot collide with a real one.
 */
const ANY_ROLE_KEY = 'any';

/** One repeatable "expected output" row. `key` is stable across add/remove. */
interface ExpectedRow {
  readonly key: number;
  readonly value: string;
  readonly error?: string;
}

/** Maps a failed create to the honest reason, never the server's own wording. */
const rejectionKey = (error: unknown): StringKey =>
  error instanceof ApiError && error.status === 400
    ? 'task.create.rejected'
    : 'task.create.failed';

/**
 * Creates a task: what it needs done, who plans it, what it should produce,
 * and any files to attach — with an option to start it immediately.
 *
 * **Mounted-to-open, like `TaskDialog`.** It holds a half-typed request the
 * user authored, same as `TaskDialog` holds nothing of the sort — but unlike
 * the chat dialog there is nowhere to park a draft, so closing it discards it.
 * There is no `onMinimise`.
 *
 * **No `TaskProvider`.** Creating a task does not open it; the new row
 * arrives through the company's own event stream, which the activity view
 * already holds open.
 *
 * **The three outcomes after a task exists are each distinct.** The create
 * call either fails outright (nothing was made, the form stays for another
 * try) or it succeeds — and once it has, this dialog never offers a second
 * submit, because that would create a second task. A successful create either
 * closes the dialog (every file attached, and if `start` was checked, the
 * task is running) or it stays open to say exactly what did not make it:
 * files that failed to upload, or soft warnings from the server. Both of
 * those leave the task exactly as created — see `useCreateTask` for why a
 * failed upload does not retry itself or undo the task.
 */
export const CreateTaskDialog = ({
  companyId,
  onClose,
}: CreateTaskDialogProps) => {
  const { data: roles } = useCompanyRolesList(companyId);
  const createTask = useCreateTask();

  const [request, setRequest] = useState('');
  const [requestError, setRequestError] = useState<string | undefined>(
    undefined,
  );
  const requestFieldRef = useRef<HTMLElement | null>(null);

  const [plannerRoleId, setPlannerRoleId] = useState<string | undefined>(
    undefined,
  );

  const [expectedRows, setExpectedRows] = useState<readonly ExpectedRow[]>([]);
  // Row identity survives add/remove, which array index does not — removing
  // row 0 would otherwise hand row 1's error to what is now displayed as row
  // 0. Each row also keeps its own focus target, addressed by that same key.
  const nextRowKey = useRef(0);
  const expectedFieldRefs = useRef(
    new Map<number, RefObject<HTMLElement | null>>(),
  );
  const expectedFieldRef = (key: number): RefObject<HTMLElement | null> => {
    const existing = expectedFieldRefs.current.get(key);
    if (existing !== undefined) return existing;
    const created: RefObject<HTMLElement | null> = { current: null };
    expectedFieldRefs.current.set(key, created);
    return created;
  };

  // ponytail: a native `<input type="file">` rather than React Aria's
  // `FileTrigger` — it is labelled, keyboard-operable and understood by every
  // assistive technology with no code of ours, and this form needs nothing
  // `FileTrigger` adds. Its own `.files` cannot be edited once chosen (there
  // is no API to remove one entry from a `FileList`), so the selection this
  // form acts on is kept here instead and rebuilt on every add or remove.
  const [files, setFiles] = useState<readonly File[]>([]);
  const materialsInputId = useId();
  const plannerRoleInputId = useId();
  const startHintId = useId();

  // `null` until the user touches the checkbox — only then does their choice
  // override the capped-aware default. A plain `useState(true)` would have no
  // way to tell "the user unchecked it" from "nobody has decided yet", which
  // is exactly the distinction 000.02 needs: the default must track the cap
  // across a live refetch, but a deliberate toggle must stick.
  const [startChoice, setStartChoice] = useState<boolean | null>(null);
  const capped = (useLiveSpendOverview().data?.caps ?? []).some(
    (cap) => cap.holding,
  );
  const start = startChoice ?? !capped;

  const addExpectedRow = (): void => {
    const key = nextRowKey.current;
    nextRowKey.current += 1;
    setExpectedRows((previous) => [...previous, { key, value: '' }]);
  };

  const removeExpectedRow = (key: number): void => {
    expectedFieldRefs.current.delete(key);
    setExpectedRows((previous) => previous.filter((row) => row.key !== key));
  };

  const updateExpectedRow = (key: number, value: string): void => {
    setExpectedRows((previous) =>
      previous.map((row) => (row.key === key ? { ...row, value } : row)),
    );
  };

  const handleSubmit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (createTask.isPending || createTask.data !== undefined) return;

    const trimmedRequest = request.trim();
    const nextRequestError =
      trimmedRequest === '' ? t('task.create.request.required') : undefined;

    const validatedRows = expectedRows.map((row) => ({
      ...row,
      error:
        row.value.trim() === ''
          ? t('task.create.expected.required')
          : undefined,
    }));

    setRequestError(nextRequestError);
    setExpectedRows(validatedRows);

    const hasError =
      nextRequestError !== undefined ||
      validatedRows.some((row) => row.error !== undefined);

    if (hasError) {
      // The fields these refs point at are already on screen — only their
      // error text is new — so focus can move immediately, with no need to
      // wait for a re-render.
      focusFirstInvalid([
        { error: nextRequestError, ref: requestFieldRef },
        ...validatedRows.map((row) => ({
          error: row.error,
          ref: expectedFieldRef(row.key),
        })),
      ]);
      return;
    }

    createTask.mutate(
      {
        companyId,
        request: trimmedRequest,
        ...(plannerRoleId === undefined ? {} : { plannerRoleId }),
        ...(validatedRows.length === 0
          ? {}
          : { expected: validatedRows.map((row) => row.value.trim()) }),
        files,
        start,
      },
      {
        onSuccess: (result) => {
          // A partial failure or a soft warning keeps the dialog open so the
          // user can see it — handled below, from `createTask.data`.
          if (result.failedUploads.length > 0 || result.warnings.length > 0) {
            return;
          }
          onClose();
          announce({
            channel: 'tasks',
            change: result.started
              ? 'task.create.announce.started'
              : 'task.create.announce.created',
            params: { shortcode: result.task.shortcode },
            throttleMs: ANNOUNCE_IMMEDIATE_MS,
          });
        },
      },
    );
  };

  // Once the task exists, this dialog never offers a second submit — doing so
  // would create a second task rather than fix the first. That covers both
  // outcomes that keep the dialog open: a partial upload failure and a soft
  // warning.
  const created = createTask.data;
  const stayingOpenAfterCreate =
    created !== undefined &&
    (created.failedUploads.length > 0 || created.warnings.length > 0);

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      heading={t('task.create.heading')}
    >
      {stayingOpenAfterCreate ? (
        <>
          {created.failedUploads.length > 0 && (
            <ErrorState
              message={t('task.create.materials.failed', {
                filenames: created.failedUploads.join(', '),
              })}
              channel="task-create-materials"
            />
          )}
          {created.warnings.length > 0 && (
            <div
              className="create-task-dialog__warnings"
              role="group"
              aria-label={t('task.create.warnings.label')}
            >
              <ul>
                {created.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
          <Button className="react-aria-Button" onPress={onClose}>
            {t('task.create.close')}
          </Button>
        </>
      ) : (
        <form onSubmit={handleSubmit}>
          {createTask.isError && (
            <ErrorState
              message={t(rejectionKey(createTask.error))}
              channel="task-create"
            />
          )}

          <div className="create-task-dialog__field">
            <TextField
              label={t('task.create.request.label')}
              description={t('task.create.request.description')}
              value={request}
              onChange={setRequest}
              errorMessage={requestError}
              isRequired
              isDisabled={createTask.isPending}
              multiline
              inputRef={requestFieldRef}
            />
          </div>

          <div className="create-task-dialog__field create-task-dialog__role-field">
            {/*
              ponytail: the native element, not React Aria's `Select`. A
              one-from-a-list choice is exactly what `<select>` is, and the
              native control is keyboard-operable and understood by every
              assistive technology — including a phone's own picker — without
              any of our code. React Aria's version also deprecates
              `selectedKey`/`onSelectionChange` in 1.20, so adopting it here
              would mean adopting a moving API for no gain. The materials
              input below is native for the same reason.
            */}
            <label
              className="create-task-dialog__role-label"
              htmlFor={plannerRoleInputId}
            >
              {t('task.create.plannerRole.label')}
              <select
                id={plannerRoleInputId}
                className="create-task-dialog__role-select"
                value={plannerRoleId ?? ANY_ROLE_KEY}
                disabled={createTask.isPending}
                onChange={(event) => {
                  const { value } = event.target;
                  setPlannerRoleId(value === ANY_ROLE_KEY ? undefined : value);
                }}
              >
                <option value={ANY_ROLE_KEY}>
                  {t('task.create.plannerRole.any')}
                </option>
                {(roles ?? []).map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="create-task-dialog__expected">
            {expectedRows.map((row, index) => (
              <div className="create-task-dialog__expected-row" key={row.key}>
                <TextField
                  label={t('task.create.expected.label', {
                    position: index + 1,
                  })}
                  description={
                    index === 0
                      ? t('task.create.expected.description')
                      : undefined
                  }
                  value={row.value}
                  onChange={(value) => {
                    updateExpectedRow(row.key, value);
                  }}
                  errorMessage={row.error}
                  isRequired
                  isDisabled={createTask.isPending}
                  inputRef={expectedFieldRef(row.key)}
                />
                <Button
                  className="react-aria-Button create-task-dialog__expected-remove"
                  isDisabled={createTask.isPending}
                  onPress={() => {
                    removeExpectedRow(row.key);
                  }}
                >
                  {t('task.create.expected.remove', { position: index + 1 })}
                </Button>
              </div>
            ))}
            <Button
              className="react-aria-Button create-task-dialog__expected-add"
              isDisabled={createTask.isPending}
              onPress={addExpectedRow}
            >
              {t('task.create.expected.add')}
            </Button>
          </div>

          <div className="create-task-dialog__materials">
            {/*
              ponytail: the native file input, not React Aria's `FileTrigger`.
              It is labelled, keyboard-operable and understood by every
              assistive technology without any of our code.

              The input is *nested inside* its label as well as being wired to
              it by `htmlFor`/`id`. Either alone names the control correctly;
              this project's `jsx-a11y/label-has-for` configuration asks for
              both, and the pairing is what a screen reader relies on.
            */}
            <label
              className="create-task-dialog__materials-label"
              htmlFor={materialsInputId}
            >
              {t('task.create.materials.label')}
              {/*
                The rule cannot see this control's label, and there is no
                arrangement of markup that would let it: the text is
                `t('task.create.materials.label')`, and jsx-a11y evaluates
                literals, not function calls. Every user-facing string in this
                application goes through `t` (ADR-021), so the rule can never
                pass for a native control here.

                The label is real and doubly wired — `htmlFor`/`id` and
                nesting. `CreateTaskDialog.test.tsx` finds this input with
                `getByLabelText`, which resolves the accessible name the same
                way a screen reader does, so the association is proven by a
                test rather than assumed by this comment.
              */}
              {/* eslint-disable-next-line jsx-a11y/control-has-associated-label -- see above: `t()` is not a literal */}
              <input
                id={materialsInputId}
                type="file"
                multiple
                disabled={createTask.isPending}
                onChange={(event) => {
                  const chosen = event.target.files;
                  if (chosen !== null) {
                    setFiles((previous) => [
                      ...previous,
                      ...Array.from(chosen),
                    ]);
                  }
                  // Cleared so picking the same file again after removing it
                  // still fires a change event — the browser otherwise treats
                  // an unchanged selection as nothing happening.
                  event.target.value = '';
                }}
              />
            </label>
            {files.length > 0 && (
              <div
                role="group"
                aria-label={t('task.create.materials.selected')}
              >
                <ul className="create-task-dialog__materials-list">
                  {files.map((file, index) => (
                    <li
                      className="create-task-dialog__materials-row"
                      key={`${file.name}-${String(index)}`}
                    >
                      {file.name}
                      <Button
                        className="react-aria-Button"
                        isDisabled={createTask.isPending}
                        onPress={() => {
                          setFiles((previous) =>
                            previous.filter((_, i) => i !== index),
                          );
                        }}
                      >
                        {t('task.create.materials.remove', {
                          filename: file.name,
                        })}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="create-task-dialog__start">
            <CheckboxField
              isSelected={start}
              onChange={setStartChoice}
              isDisabled={createTask.isPending}
              aria-describedby={capped ? startHintId : undefined}
            >
              <CheckboxButton>{t('task.create.start.label')}</CheckboxButton>
            </CheckboxField>
            {capped && (
              <p id={startHintId} className="create-task-dialog__start-hint">
                {t('task.create.start.cappedHint')}
              </p>
            )}
          </div>

          <div className="create-task-dialog__actions">
            <Button
              className="react-aria-Button"
              type="submit"
              isDisabled={createTask.isPending}
            >
              {createTask.isPending
                ? t('task.create.submit.pending')
                : t('task.create.submit')}
            </Button>
            <Button
              className="react-aria-Button"
              isDisabled={createTask.isPending}
              onPress={onClose}
            >
              {t('task.create.discard')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
};
