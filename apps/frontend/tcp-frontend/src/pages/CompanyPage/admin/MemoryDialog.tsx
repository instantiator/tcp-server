import { MAX_MEMORY_LENGTH } from '@tcp/shared/client';
import { useRef, useState, type SubmitEvent } from 'react';
import { Button } from 'react-aria-components';
import { ApiError } from '../../../api/errors';
import { ButtonRow } from '../../../components/ButtonRow/ButtonRow';
import { Dialog } from '../../../components/Dialog/Dialog';
import { TextField } from '../../../components/Field/TextField';
import { t } from '../../../strings';

export interface MemoryDialogProps {
  /** The memory being edited, or `undefined` to add one. */
  readonly initial?: { readonly content: string; readonly tags: string[] };
  /** Saves the memory; a rejection is shown in the dialog, which stays open. */
  readonly onSave: (content: string, tags: string[]) => Promise<void>;
  readonly onClose: () => void;
}

/** Tags as typed: comma-separated, trimmed, without blanks. */
const parseTags = (text: string): string[] =>
  text
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);

/**
 * Adds or rewords one memory (002.06). The text stops at the server's limit
 * as it is typed, and the hint keeps count, so nothing is refused for length
 * after the fact. Closing returns focus to whatever opened it.
 */
export const MemoryDialog = ({
  initial,
  onSave,
  onClose,
}: MemoryDialogProps) => {
  const [content, setContent] = useState(initial?.content ?? '');
  const [tags, setTags] = useState(initial?.tags.join(', ') ?? '');
  const [missing, setMissing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const contentRef = useRef<HTMLElement | null>(null);

  const submit = async (event: SubmitEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (content.trim() === '') {
      setMissing(true);
      contentRef.current?.focus();
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      await onSave(content.trim(), parseTags(tags));
    } catch (error) {
      setProblem(
        t('memory.dialog.failed', {
          message:
            error instanceof ApiError
              ? error.message
              : t('records.error.generic'),
        }),
      );
      setSaving(false);
    }
  };

  return (
    <Dialog
      heading={t(
        initial === undefined
          ? 'memory.dialog.addHeading'
          : 'memory.dialog.editHeading',
      )}
      onClose={onClose}
    >
      <form onSubmit={(event) => void submit(event)}>
        <TextField
          label={t('memory.dialog.content')}
          description={t('memory.dialog.contentHint', {
            count: content.length,
            max: MAX_MEMORY_LENGTH,
          })}
          value={content}
          onChange={(value) => {
            setContent(value);
            setMissing(false);
          }}
          errorMessage={
            missing ? t('memory.dialog.contentRequired') : undefined
          }
          isRequired
          multiline
          maxLength={MAX_MEMORY_LENGTH}
          inputRef={contentRef}
        />
        <TextField
          label={t('memory.dialog.tags')}
          description={t('memory.dialog.tagsHint')}
          value={tags}
          onChange={setTags}
        />
        {problem !== null && (
          <p className="tcp-field__error" role="alert">
            {problem}
          </p>
        )}
        <ButtonRow>
          <Button
            className="react-aria-Button"
            type="submit"
            isPending={saving}
          >
            {t('memory.dialog.save')}
          </Button>
          <Button
            className="react-aria-Button tcp-button--outline"
            onPress={onClose}
          >
            {t('memory.dialog.cancel')}
          </Button>
        </ButtonRow>
      </form>
    </Dialog>
  );
};
