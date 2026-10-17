import { useRef, useState, type SubmitEvent } from 'react';
import { Button } from 'react-aria-components';
import { announce } from '../../announce/announcer';
import type { TemplateSourceDTO } from '../../api/dtos';
import { ApiError } from '../../api/errors';
import {
  useAddTemplateSource,
  useRemoveTemplateSource,
  useTemplateSources,
} from '../../api/hooks';
import { t } from '../../strings';
import { ButtonRow } from '../ButtonRow/ButtonRow';
import { ConfirmDialog } from '../Dialog/ConfirmDialog';
import { Dialog } from '../Dialog/Dialog';
import { ErrorState } from '../ErrorState/ErrorState';
import { focusFirstInvalid } from '../Field/focusFirstInvalid';
import { TextField } from '../Field/TextField';
import { LoadingState } from '../LoadingState/LoadingState';

/** This dialog is the one writer on its announcer channel. */
const CHANNEL = 'template-sources';

/** `owner/repo`, as GitHub spells them. */
const REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export interface TemplateSourcesDialogProps {
  readonly onClose: () => void;
}

/**
 * Lists the places the template gallery reads from and lets an administrator
 * add a GitHub repository or remove one added here (002.03). Built-in and
 * config sources are fixed, so they have no Remove button.
 *
 * Removing asks first, and afterwards focus goes to the form's first field:
 * the row that held it is gone (ADR-027's destructive completion).
 */
export const TemplateSourcesDialog = ({
  onClose,
}: TemplateSourcesDialogProps) => {
  const sources = useTemplateSources();
  const add = useAddTemplateSource();
  const remove = useRemoveTemplateSource();

  const [name, setName] = useState('');
  const [repo, setRepo] = useState('');
  const [ref, setRef] = useState('');
  const [path, setPath] = useState('');
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState<TemplateSourceDTO | null>(null);
  const [removeProblem, setRemoveProblem] = useState<string | null>(null);

  const nameRef = useRef<HTMLElement | null>(null);
  const repoRef = useRef<HTMLElement | null>(null);

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (name.trim() === '') {
      found['name'] = t('system.templateSources.add.nameRequired');
    }
    if (!REPO_PATTERN.test(repo.trim())) {
      found['repo'] = t('system.templateSources.add.repoInvalid');
    }
    setErrors(found);
    if (Object.keys(found).length > 0) {
      focusFirstInvalid([
        { error: found['name'], ref: nameRef },
        { error: found['repo'], ref: repoRef },
      ]);
      return;
    }

    try {
      await add.mutateAsync({
        name: name.trim(),
        repo: repo.trim(),
        ...(ref.trim() !== '' && { ref: ref.trim() }),
        ...(path.trim() !== '' && { path: path.trim() }),
      });
      announce({
        channel: CHANNEL,
        change: 'system.templateSources.announce.added',
        params: { name: name.trim() },
      });
      setName('');
      setRepo('');
      setRef('');
      setPath('');
      setProblem(null);
    } catch (error) {
      setProblem(
        error instanceof ApiError && error.status === 409
          ? t('system.templateSources.add.duplicate')
          : error instanceof ApiError && error.status === 400
            ? error.message
            : t('records.error.generic'),
      );
    }
  };

  const confirmRemove = async (source: TemplateSourceDTO): Promise<void> => {
    setRemoving(null);
    try {
      await remove.mutateAsync(source.id);
    } catch (error) {
      setRemoveProblem(
        t('system.templateSources.removeFailed', {
          message:
            error instanceof ApiError
              ? error.message
              : t('records.error.generic'),
        }),
      );
      return;
    }
    setRemoveProblem(null);
    announce({
      channel: CHANNEL,
      change: 'system.templateSources.announce.removed',
      params: { name: source.name },
    });
    nameRef.current?.focus();
  };

  const list = () => {
    if (sources.isPending) {
      return <LoadingState label={t('system.templateSources.loading')} />;
    }
    if (sources.isError) {
      return (
        <ErrorState
          message={t('system.templateSources.error')}
          channel={CHANNEL}
          onRetry={() => {
            void sources.refetch();
          }}
        />
      );
    }
    if (sources.data.length === 0) {
      return <p>{t('system.templateSources.empty')}</p>;
    }
    return (
      <ul>
        {sources.data.map((source) => (
          <li key={source.id}>
            <strong>{source.name}</strong>
            <p>
              {source.location}
              {' · '}
              {t(`system.templateSources.origin.${source.origin}`)}
            </p>
            {source.origin === 'user' && (
              <Button
                className="react-aria-Button tcp-button--outline"
                onPress={() => {
                  setRemoveProblem(null);
                  setRemoving(source);
                }}
              >
                {t('system.templateSources.remove', { name: source.name })}
              </Button>
            )}
          </li>
        ))}
      </ul>
    );
  };

  return (
    <Dialog onClose={onClose} heading={t('system.templateSources.heading')}>
      <p>{t('system.templateSources.intro')}</p>
      {list()}
      {removeProblem !== null && (
        <p className="tcp-field__error" role="alert">
          {removeProblem}
        </p>
      )}

      <form onSubmit={(event) => void submit(event)}>
        <h3>{t('system.templateSources.add.heading')}</h3>
        <TextField
          label={t('system.templateSources.add.name')}
          value={name}
          onChange={setName}
          isRequired
          {...(errors['name'] !== undefined && {
            errorMessage: errors['name'],
          })}
          inputRef={nameRef}
        />
        <TextField
          label={t('system.templateSources.add.repo')}
          description={t('system.templateSources.add.repoHint')}
          value={repo}
          onChange={setRepo}
          isRequired
          {...(errors['repo'] !== undefined && {
            errorMessage: errors['repo'],
          })}
          inputRef={repoRef}
        />
        <TextField
          label={t('system.templateSources.add.ref')}
          description={t('system.templateSources.add.refHint')}
          value={ref}
          onChange={setRef}
        />
        <TextField
          label={t('system.templateSources.add.path')}
          description={t('system.templateSources.add.pathHint')}
          value={path}
          onChange={setPath}
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
            isPending={add.isPending}
          >
            {t('system.templateSources.add.submit')}
          </Button>
        </ButtonRow>
      </form>

      <ConfirmDialog
        isOpen={removing !== null}
        heading={t('system.templateSources.removeHeading', {
          name: removing?.name ?? '',
        })}
        message={t('system.templateSources.removeMessage')}
        confirmLabel={t('system.templateSources.removeConfirm')}
        onConfirm={() => {
          if (removing !== null) void confirmRemove(removing);
        }}
        onCancel={() => {
          setRemoving(null);
        }}
      />
    </Dialog>
  );
};
