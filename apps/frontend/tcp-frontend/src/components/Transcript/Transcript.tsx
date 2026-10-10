import { isBlankText, type LogEntry } from '@tcp/shared/client';
import { ArrowDownToLine } from 'lucide-react';
import { useState } from 'react';
import { ToggleButton } from 'react-aria-components';
import { t, type StringKey } from '../../strings';
import { EmptyState } from '../EmptyState/EmptyState';
import { ErrorState } from '../ErrorState/ErrorState';
import { Icon, WithTooltip } from '../Icon/Icon';
import { LoadingState } from '../LoadingState/LoadingState';
import { useReasoningRule, type ReasoningRule } from './reasoningRule';
import { useFollow } from './useFollow';
import { useTranscript, type TranscriptStatus } from './useTranscript';
import './Transcript.css';

export interface TranscriptProps {
  /** The agent whose work this shows. */
  readonly agentId: string;
  /** The agent's role, which names the conversation and its announcements. */
  readonly roleName: string;
  /** Where the follow button's tooltip is portalled; see `WithTooltip`. */
  readonly portalContainer?: Element | undefined;
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

/** Whether a reasoning entry starts open under the rule. */
const openByRule = (
  rule: ReasoningRule,
  index: number,
  latestReasoning: number,
): boolean =>
  rule === 'all' || (rule === 'latest' && index === latestReasoning);

/** The user's own open/closed choices, valid only for the rule they were made under. */
interface Overrides {
  readonly rule: ReasoningRule;
  readonly open: ReadonlyMap<number, boolean>;
}

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
export const Transcript = ({
  agentId,
  roleName,
  portalContainer,
}: TranscriptProps) => {
  const { entries, status } = useTranscript(agentId, roleName);
  const rule = useReasoningRule();
  const [overrides, setOverrides] = useState<Overrides>({
    rule,
    open: new Map(),
  });
  const follow = useFollow(entries);

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

  // A change of rule resets every individual choice (000.06).
  const chosen = overrides.rule === rule ? overrides.open : undefined;
  const latestReasoning = entries.findLastIndex(
    (entry) => entry.style === 'reasoning',
  );
  const followLabel = t('transcript.follow');

  return (
    <div className="transcript-view">
      <ol
        ref={follow.ref}
        className="transcript"
        aria-label={t('transcript.label', { role: roleName })}
        onScroll={follow.onScroll}
      >
        {entries.map((entry, index) => {
          const meta = t('transcript.entry.label', {
            time: entry.time,
            label: entry.label ?? '',
          });
          const className = `transcript__entry transcript__entry--${entry.style}`;
          if (entry.style !== 'reasoning') {
            return (
              // The list only ever appends, and only its last entry changes, so
              // an index is stable for every entry that already exists.
              <li key={index} className={className}>
                <p className="transcript__meta">{meta}</p>
                <EntryBody entry={entry} />
              </li>
            );
          }
          const isOpen =
            chosen?.get(index) ?? openByRule(rule, index, latestReasoning);
          return (
            <li key={index} className={className}>
              {/*
                Native disclosure: the browser supplies the keyboard handling
                and the expanded state a screen reader announces. Controlled, so
                the rule decides first and the user's own toggle wins after.
              */}
              <details
                open={isOpen}
                onToggle={(event) => {
                  const nowOpen = event.currentTarget.open;
                  // Fires for React's own `open` changes too; only a change
                  // away from what the rule says is the user's choice.
                  if (nowOpen === isOpen) return;
                  setOverrides({
                    rule,
                    open: new Map(chosen).set(index, nowOpen),
                  });
                }}
              >
                <summary className="transcript__meta">{meta}</summary>
                <EntryBody entry={entry} />
              </details>
            </li>
          );
        })}
      </ol>
      <WithTooltip label={followLabel} portalContainer={portalContainer}>
        <ToggleButton
          className="react-aria-ToggleButton tcp-icon-button tcp-icon-button--small transcript-view__follow"
          aria-label={followLabel}
          isSelected={follow.following}
          onChange={follow.setFollowing}
        >
          <Icon icon={ArrowDownToLine} />
        </ToggleButton>
      </WithTooltip>
    </div>
  );
};
