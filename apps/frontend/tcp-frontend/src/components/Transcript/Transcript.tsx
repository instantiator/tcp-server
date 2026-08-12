import { isBlankText, type LogEntry } from '@tcp/shared/client';
import { t, type StringKey } from '../../strings';
import { EmptyState } from '../EmptyState/EmptyState';
import { ErrorState } from '../ErrorState/ErrorState';
import { LoadingState } from '../LoadingState/LoadingState';
import { useTranscript, type TranscriptStatus } from './useTranscript';
import './Transcript.css';

export interface TranscriptProps {
  /** The agent whose work this shows. */
  readonly agentId: string;
  /** The agent's role, which names the conversation and its announcements. */
  readonly roleName: string;
}

/** What each unhappy status says. `loading` and `ready` render something else. */
const FAILURE_MESSAGES: Record<
  Exclude<TranscriptStatus, 'loading' | 'ready'>,
  StringKey
> = {
  refused: 'transcript.error.refused',
  'at-capacity': 'transcript.error.atCapacity',
  failed: 'transcript.error.failed',
};

/**
 * One entry's content.
 *
 * A line-only entry — `llm_request`, or an `llm_response` whose text already
 * streamed — carries no text at all, and renders as its heading line alone.
 * `json` marks text the shared renderer already pretty-printed, so it is shown
 * verbatim rather than reflowed.
 */
const EntryBody = ({ entry }: { readonly entry: LogEntry }) => {
  if (entry.json === true) {
    return <pre className="transcript__json">{entry.text}</pre>;
  }
  if (entry.style === 'response' && isBlankText(entry.text)) {
    // The same placeholder the CLI shows, from the same rule — an agent that
    // answered with nothing is a real outcome, not a rendering gap.
    return <p className="transcript__text">{t('transcript.blank')}</p>;
  }
  if (isBlankText(entry.text)) return null;
  return <p className="transcript__text">{entry.text}</p>;
};

/**
 * An agent's event stream, as a readable conversation.
 *
 * Every entry comes from the shared renderers in `@tcp/shared/client`, which
 * the CLI uses too — so the two clients cannot disagree about what an event
 * means. This component supplies only the presentation the terminal version
 * cannot: real elements, and CSS wrapping instead of fixed-width text.
 *
 * An ordered list, one item per entry, each carrying its time and what kind of
 * event it was. That is what makes the transcript browsable entry by entry
 * with a screen reader's virtual cursor, which ADR-027 requires: the content
 * is fully exposed, and only the announcements are curated.
 */
export const Transcript = ({ agentId, roleName }: TranscriptProps) => {
  const { entries, status } = useTranscript(agentId, roleName);

  if (status === 'loading') {
    return <LoadingState label={t('transcript.loading')} />;
  }

  if (status !== 'ready') {
    // No retry: a refusal is an answer, and the connection budget needs a
    // dialog closed rather than a button pressed. Neither is a spinner.
    return (
      <ErrorState
        message={t(FAILURE_MESSAGES[status])}
        channel={`transcript:${agentId}`}
      />
    );
  }

  if (entries.length === 0) {
    return (
      <EmptyState heading={t('transcript.empty.heading')} headingLevel={3}>
        {t('transcript.empty.body')}
      </EmptyState>
    );
  }

  return (
    <ol
      className="transcript"
      aria-label={t('transcript.label', { role: roleName })}
    >
      {entries.map((entry, index) => (
        <li
          // The list only ever appends, and only its last entry changes, so an
          // index is stable for every entry that already exists.
          key={index}
          className={`transcript__entry transcript__entry--${entry.style}`}
        >
          <p className="transcript__meta">
            {t('transcript.entry.label', {
              time: entry.time,
              label: entry.label ?? '',
            })}
          </p>
          <EntryBody entry={entry} />
        </li>
      ))}
    </ol>
  );
};
