import { RefreshCcw, RefreshCw, Trash2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type SubmitEvent } from 'react';
import { Button } from 'react-aria-components';
import { announce } from '../../../announce/announcer';
import { ApiError } from '../../../api/errors';
import {
  useDeleteKnowledge,
  useKnowledgeList,
  useKnowledgeSearch,
  useKnowledgeStatus,
  useReindexKnowledge,
  useUploadKnowledge,
  type KnowledgeScope,
} from '../../../api/hooks';
import { ButtonRow } from '../../../components/ButtonRow/ButtonRow';
import { ConfirmDialog } from '../../../components/Dialog/ConfirmDialog';
import { ErrorState } from '../../../components/ErrorState/ErrorState';
import { TextField } from '../../../components/Field/TextField';
import { LoadingState } from '../../../components/LoadingState/LoadingState';
import { RoundIconButton } from '../../../components/RoundIconButton/RoundIconButton';
import { t, tCount } from '../../../strings';
import './KnowledgePanel.css';

/** This panel is the one writer on this announcer channel. */
const KNOWLEDGE_CHANNEL = 'knowledge';

/** What the server converts (`knowledge-conversion.ts`); offered to the file picker so it shows only these. */
const ACCEPTED_TYPES = '.md,.txt,.html,.pdf,.docx,.csv,.json,.yaml';

const sizeFormat = new Intl.NumberFormat(undefined, {
  style: 'unit',
  unit: 'kilobyte',
  maximumFractionDigits: 0,
});
const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** A size in whole kilobytes, rounding up so a small file never reads as 0 kB. */
const formatSize = (bytes: number): string =>
  sizeFormat.format(Math.ceil(bytes / 1024));

/** The file name at the end of a chunk's storage path. */
const sourceName = (documentPath: string): string =>
  documentPath.split('/').pop() ?? documentPath;

/** An error's message for the reader: the server's own words, or a generic line. */
const messageOf = (error: unknown): string =>
  error instanceof ApiError ? error.message : t('records.error.generic');

export interface KnowledgePanelProps {
  /** Whose knowledge: one role's, or the company's shared knowledge. */
  readonly scope: KnowledgeScope;
  /** The panel's heading level: 2 on the Admin page, 3 inside the role dialog. */
  readonly headingLevel: 2 | 3;
}

/**
 * One knowledge scope's documents, index status and a test search (002.00).
 * The role dialog's Knowledge tab and Admin → Knowledge both render it.
 *
 * **Uploads index themselves.** Storing a file queues a rebuild on the
 * server, so "Rebuild the index" is a retry for a failed or stale index, not
 * a step to remember; it is disabled while a rebuild or an upload runs.
 *
 * **Status is polled, not pushed.** Nothing streams a knowledge index, so
 * `useKnowledgeStatus` asks every few seconds while a rebuild runs, and this
 * panel announces when it ends ("ready" or "failed"). Refresh asks now.
 *
 * **Uploading is cancellable.** The request carries an `AbortSignal`; Cancel
 * aborts it. `fetch` reports no byte progress, so the panel says what is
 * uploading rather than how far along it is.
 *
 * **Deleting asks first**, then puts focus on the next document's name, or
 * on the upload control when none is left (ADR-027's destructive completion).
 *
 * **The search uses no language model.** It shows the passages an agent
 * would be handed for the query, with their source and how close a match
 * they are, so a person can check what the knowledge holds.
 */
export const KnowledgePanel = ({
  scope,
  headingLevel,
}: KnowledgePanelProps) => {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const Subheading = headingLevel === 2 ? 'h3' : 'h4';
  const headingId = useId();
  const uploadId = useId();
  const hintId = useId();

  const documents = useKnowledgeList(scope);
  const status = useKnowledgeStatus(scope);
  const upload = useUploadKnowledge(scope);
  const remove = useDeleteKnowledge(scope);
  const reindex = useReindexKnowledge(scope);

  const [uploading, setUploading] = useState<{
    readonly name: string;
    readonly controller: AbortController;
  } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [focusAfterDelete, setFocusAfterDelete] = useState<
    string | null | undefined
  >(undefined);
  const nameRefs = useRef(new Map<string, HTMLTableCellElement>());
  const uploadRef = useRef<HTMLInputElement>(null);

  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const results = useKnowledgeSearch(scope, query);

  const indexing = status.data?.indexing === true;

  // Announce the end of a rebuild: the one change here nobody pressed for.
  const wasIndexing = useRef(false);
  useEffect(() => {
    if (wasIndexing.current && !indexing && status.data !== undefined) {
      announce({
        channel: KNOWLEDGE_CHANNEL,
        change:
          status.data.lastError === null
            ? 'knowledge.announce.ready'
            : 'knowledge.announce.failed',
      });
    }
    wasIndexing.current = indexing;
  }, [indexing, status.data]);

  // After a delete the list refetches; focus waits for it, so it lands on a
  // row that is really there.
  useEffect(() => {
    if (focusAfterDelete === undefined || documents.isFetching) return;
    const target =
      focusAfterDelete === null
        ? undefined
        : nameRefs.current.get(focusAfterDelete);
    (target ?? uploadRef.current)?.focus();
    setFocusAfterDelete(undefined);
  }, [focusAfterDelete, documents.isFetching]);

  const startUpload = async (file: File): Promise<void> => {
    const controller = new AbortController();
    setProblem(null);
    setUploading({ name: file.name, controller });
    try {
      await upload.mutateAsync({ file, signal: controller.signal });
      announce({
        channel: KNOWLEDGE_CHANNEL,
        change: 'knowledge.announce.uploaded',
        params: { name: file.name },
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        announce({
          channel: KNOWLEDGE_CHANNEL,
          change: 'knowledge.announce.cancelled',
        });
      } else {
        setProblem(
          error instanceof ApiError && error.status === 413
            ? t('knowledge.tooLarge')
            : t('knowledge.uploadFailed', { message: messageOf(error) }),
        );
      }
    } finally {
      setUploading(null);
    }
  };

  const confirmDelete = async (name: string): Promise<void> => {
    setDeleting(null);
    const names = (documents.data ?? []).map((doc) => doc.name);
    const index = names.indexOf(name);
    const next = names[index + 1] ?? names[index - 1] ?? null;
    try {
      await remove.mutateAsync(name);
      announce({
        channel: KNOWLEDGE_CHANNEL,
        change: 'knowledge.announce.deleted',
        params: { name },
      });
      setFocusAfterDelete(next);
    } catch (error) {
      setProblem(
        t('knowledge.deleteFailed', { name, message: messageOf(error) }),
      );
    }
  };

  const search = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setQuery(draft.trim());
  };

  return (
    <section aria-labelledby={headingId} className="knowledge-panel">
      <Heading id={headingId}>
        {t(
          scope.kind === 'company'
            ? 'knowledge.headingShared'
            : 'knowledge.heading',
        )}
      </Heading>
      {scope.kind === 'company' && <p>{t('knowledge.introShared')}</p>}

      <div className="knowledge-panel__status">
        {status.isPending ? (
          <LoadingState label={t('knowledge.status.loading')} />
        ) : status.isError ? (
          <ErrorState
            message={t('knowledge.list.error')}
            channel={KNOWLEDGE_CHANNEL}
            onRetry={() => void status.refetch()}
          />
        ) : (
          <p>
            {tCount('knowledge.status.documents', status.data.documentCount)}
            {', '}
            {tCount('knowledge.status.chunks', status.data.chunkCount)}
            {'. '}
            {indexing
              ? t('knowledge.status.indexing')
              : status.data.lastIndexedAt === null
                ? t('knowledge.status.never')
                : t('knowledge.status.lastIndexed', {
                    when: dateFormat.format(
                      new Date(status.data.lastIndexedAt),
                    ),
                  })}
          </p>
        )}
        {status.data?.lastError != null && !indexing && (
          <p className="tcp-field__error">
            {t('knowledge.status.error', { message: status.data.lastError })}
          </p>
        )}
        <div className="knowledge-panel__actions">
          <RoundIconButton
            icon={RefreshCw}
            label={t('knowledge.refresh')}
            isPending={status.isFetching}
            onPress={() => void status.refetch()}
          />
          <RoundIconButton
            icon={RefreshCcw}
            label={t('knowledge.rebuild')}
            isDisabled={indexing || uploading !== null}
            isPending={reindex.isPending}
            onPress={() =>
              void reindex.mutateAsync().then(
                () =>
                  announce({
                    channel: KNOWLEDGE_CHANNEL,
                    change: 'knowledge.announce.rebuilding',
                  }),
                (error: unknown) => setProblem(messageOf(error)),
              )
            }
          />
        </div>
      </div>

      <div className="knowledge-panel__upload">
        {/*
          ponytail: a native file input, as `CreateTaskDialog` uses: labelled,
          keyboard-operable and understood by every assistive technology with
          no code of ours. Nested in its label and wired by `htmlFor` too, as
          this project's jsx-a11y configuration asks.
        */}
        <label htmlFor={uploadId}>
          {t('knowledge.upload')}
          {/* eslint-disable-next-line jsx-a11y/control-has-associated-label -- the label is `t()`, which jsx-a11y can't read; see CreateTaskDialog */}
          <input
            id={uploadId}
            ref={uploadRef}
            type="file"
            accept={ACCEPTED_TYPES}
            aria-describedby={hintId}
            disabled={uploading !== null}
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Cleared so choosing the same file again still fires a change.
              event.target.value = '';
              if (file !== undefined) void startUpload(file);
            }}
          />
        </label>
        <p id={hintId} className="tcp-field__hint">
          {t('knowledge.uploadHint')}
        </p>
        {uploading !== null && (
          <div className="knowledge-panel__uploading">
            <LoadingState
              label={t('knowledge.uploading', { name: uploading.name })}
            />
            <RoundIconButton
              icon={X}
              label={t('knowledge.cancelUpload')}
              onPress={() => uploading.controller.abort()}
            />
          </div>
        )}
        {problem !== null && (
          <p className="tcp-field__error" role="alert">
            {problem}
          </p>
        )}
      </div>

      {documents.isPending ? (
        <LoadingState label={t('knowledge.list.loading')} />
      ) : documents.isError ? (
        <ErrorState
          message={t('knowledge.list.error')}
          channel={KNOWLEDGE_CHANNEL}
          onRetry={() => void documents.refetch()}
        />
      ) : documents.data.length === 0 ? (
        <p>{t('knowledge.list.empty')}</p>
      ) : (
        <table className="tcp-table" aria-labelledby={headingId}>
          <thead>
            <tr>
              <th scope="col">{t('knowledge.column.name')}</th>
              <th scope="col">{t('knowledge.column.size')}</th>
              <th scope="col">{t('knowledge.column.modified')}</th>
              <th scope="col">{t('knowledge.column.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {documents.data.map((doc) => (
              <tr key={doc.key}>
                <th
                  scope="row"
                  tabIndex={-1}
                  ref={(cell) => {
                    if (cell === null) nameRefs.current.delete(doc.name);
                    else nameRefs.current.set(doc.name, cell);
                  }}
                >
                  {doc.name}
                </th>
                <td>{formatSize(doc.size)}</td>
                <td>{dateFormat.format(new Date(doc.lastModified))}</td>
                <td>
                  <RoundIconButton
                    icon={Trash2}
                    label={t('knowledge.delete', { name: doc.name })}
                    onPress={() => setDeleting(doc.name)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form className="knowledge-panel__query" onSubmit={search}>
        <Subheading>{t('knowledge.query.heading')}</Subheading>
        <TextField
          label={t('knowledge.query.label')}
          description={t('knowledge.query.hint')}
          value={draft}
          onChange={setDraft}
        />
        <ButtonRow>
          <Button
            className="react-aria-Button"
            type="submit"
            isDisabled={draft.trim() === ''}
          >
            {t('knowledge.query.submit')}
          </Button>
        </ButtonRow>
      </form>
      {query !== '' &&
        (results.isPending ? (
          <LoadingState label={t('knowledge.query.loading')} />
        ) : results.isError ? (
          <ErrorState
            message={t('knowledge.query.error')}
            channel={KNOWLEDGE_CHANNEL}
            onRetry={() => void results.refetch()}
          />
        ) : results.data.length === 0 ? (
          <p>{t('knowledge.query.none', { q: query })}</p>
        ) : (
          <table className="tcp-table">
            <caption>{t('knowledge.query.results', { q: query })}</caption>
            <thead>
              <tr>
                <th scope="col">{t('knowledge.query.column.source')}</th>
                <th scope="col">{t('knowledge.query.column.match')}</th>
                <th scope="col">{t('knowledge.query.column.text')}</th>
              </tr>
            </thead>
            <tbody>
              {results.data.map((chunk) => (
                <tr key={chunk.id}>
                  <td>{sourceName(chunk.documentPath)}</td>
                  <td>
                    {t('knowledge.query.match', {
                      percent: Math.round(chunk.similarity * 100),
                    })}
                  </td>
                  <td className="knowledge-panel__passage">{chunk.content}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}

      <ConfirmDialog
        isOpen={deleting !== null}
        heading={t('knowledge.deleteHeading', { name: deleting ?? '' })}
        message={t('knowledge.deleteMessage')}
        confirmLabel={t('knowledge.deleteConfirm')}
        onConfirm={() => {
          if (deleting !== null) void confirmDelete(deleting);
        }}
        onCancel={() => setDeleting(null)}
      />
    </section>
  );
};
