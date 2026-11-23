import { RefreshCcw, RefreshCw } from 'lucide-react';
import { useEffect, useId, useRef, useState, type SubmitEvent } from 'react';
import { Button } from 'react-aria-components';
import { announce } from '../../../announce/announcer';
import { ApiError } from '../../../api/errors';
import {
  useKnowledgeSearch,
  useKnowledgeStatus,
  useReindexKnowledge,
  type KnowledgeScope,
} from '../../../api/hooks';
import { ButtonRow } from '../../../components/ButtonRow/ButtonRow';
import { ErrorState } from '../../../components/ErrorState/ErrorState';
import { TextField } from '../../../components/Field/TextField';
import { LoadingState } from '../../../components/LoadingState/LoadingState';
import { RoundIconButton } from '../../../components/RoundIconButton/RoundIconButton';
import { StorageBrowser } from '../../../components/StorageBrowser/StorageBrowser';
import { t, tCount } from '../../../strings';
import './KnowledgePanel.css';

/** This panel is the one writer on this announcer channel. */
const KNOWLEDGE_CHANNEL = 'knowledge';

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** The file name at the end of a chunk's storage path. */
const sourceName = (documentPath: string): string =>
  documentPath.split('/').pop() ?? documentPath;

/** An error's message for the reader: the server's own words, or a generic line. */
const messageOf = (error: unknown): string =>
  error instanceof ApiError ? error.message : t('records.error.generic');

export interface KnowledgePanelProps {
  readonly companyId: string;
  /** Whose knowledge: one role's, or the company's shared knowledge. */
  readonly scope: KnowledgeScope;
  /** The scope's storage folder: `knowledge/shared/` or `knowledge/{role slug}/`. */
  readonly folder: string;
  /** The panel's heading level: 2 on the Admin page, 3 inside the role dialog. */
  readonly headingLevel: 2 | 3;
}

/**
 * One knowledge scope's documents, index status and a test search (002.00).
 * The role dialog's Knowledge tab and Admin → Knowledge both render it.
 *
 * **The documents are a storage browser** rooted at the scope's folder
 * (002.10). It uploads through the knowledge route, after saying the files
 * will be converted, and deletes through it too, so the index follows.
 *
 * **Uploads index themselves.** Storing a file queues a rebuild on the
 * server, so "Rebuild the index" is a retry for a failed or stale index, not
 * a step to remember; it is disabled while a rebuild runs.
 *
 * **Status is polled, not pushed.** Nothing streams a knowledge index, so
 * `useKnowledgeStatus` asks every few seconds while a rebuild runs, and this
 * panel announces when it ends ("ready" or "failed"). Refresh asks now.
 *
 * **The search uses no language model.** It shows the passages an agent
 * would be handed for the query, with their source and how close a match
 * they are, so a person can check what the knowledge holds.
 */
export const KnowledgePanel = ({
  companyId,
  scope,
  folder,
  headingLevel,
}: KnowledgePanelProps) => {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const Subheading = headingLevel === 2 ? 'h3' : 'h4';
  const headingId = useId();

  const status = useKnowledgeStatus(scope);
  const reindex = useReindexKnowledge(scope);
  const [problem, setProblem] = useState<string | null>(null);

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

  const search = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setQuery(draft.trim());
  };

  const heading = t(
    scope.kind === 'company' ? 'knowledge.headingShared' : 'knowledge.heading',
  );

  return (
    <section aria-labelledby={headingId} className="knowledge-panel">
      <Heading id={headingId}>{heading}</Heading>
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
            isDisabled={indexing}
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
        {problem !== null && (
          <p className="tcp-field__error" role="alert">
            {problem}
          </p>
        )}
      </div>

      <p className="tcp-field__hint">{t('knowledge.uploadHint')}</p>
      <StorageBrowser companyId={companyId} root={folder} label={heading} />

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
    </section>
  );
};
