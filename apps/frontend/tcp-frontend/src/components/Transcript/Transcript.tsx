import {
  isBlankText,
  type ConsultationStep,
  type LogEntry,
  type ToolSummary,
} from '@tcp/shared/client';
import { ArrowDownToLine } from 'lucide-react';
import { use, useState } from 'react';
import { Button, ToggleButton } from 'react-aria-components';
import { t, type StringKey } from '../../strings';
import { ChatContext } from '../ChatDialog/useChat';
import { EmptyState } from '../EmptyState/EmptyState';
import { ErrorState } from '../ErrorState/ErrorState';
import { Icon, WithTooltip } from '../Icon/Icon';
import { LoadingState } from '../LoadingState/LoadingState';
import { Markdown } from './Markdown';
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
 * A tool entry: a small table of its key facts, then the full JSON behind a
 * disclosure. The JSON is the shared renderer's, unchanged, so nothing the
 * summary leaves out is lost.
 */
const ToolBody = ({
  entry,
  tool,
}: {
  readonly entry: LogEntry;
  readonly tool: ToolSummary;
}) => {
  const isResult = entry.label?.startsWith('tool_result') === true;
  const rows: readonly [StringKey, string | undefined][] = [
    ['transcript.tool.name', tool.name],
    ['transcript.tool.status', isResult ? tool.status : undefined],
    ['transcript.tool.content', isResult ? tool.content : undefined],
  ];
  return (
    <>
      <table className="transcript__tool">
        <thead>
          <tr>
            <th scope="col">
              {t(
                isResult
                  ? 'transcript.tool.responseField'
                  : 'transcript.tool.requestField',
              )}
            </th>
            <th scope="col">{t('transcript.tool.value')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([key, value]) =>
            value === undefined ? null : (
              <tr key={key}>
                <th scope="row">{t(key)}</th>
                <td>
                  {key === 'transcript.tool.name' ? (
                    <code>{value}</code>
                  ) : (
                    value
                  )}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      <details className="transcript__json-details">
        <summary>{t('transcript.tool.fullJson')}</summary>
        <pre className="transcript__json">{entry.text}</pre>
      </details>
    </>
  );
};

/**
 * One entry's content.
 *
 * A line-only entry — `llm_request`, or an `llm_response` whose text already
 * streamed — carries no text at all, and renders as its heading line alone.
 * Tool entries get a summary table; other `json` text is shown verbatim.
 * Everything else is the agent's or user's prose, rendered as markdown.
 */
const EntryBody = ({ entry }: { readonly entry: LogEntry }) => {
  if (entry.tool !== undefined) {
    return <ToolBody entry={entry} tool={entry.tool} />;
  }
  if (entry.json === true) {
    return <pre className="transcript__json">{entry.text}</pre>;
  }
  if (entry.style === 'response' && isBlankText(entry.text)) {
    // The same placeholder the CLI shows, from the same rule — an agent that
    // answered with nothing is a real outcome, not a rendering gap.
    return <p className="transcript__text">{t('transcript.blank')}</p>;
  }
  if (isBlankText(entry.text)) return null;
  return <Markdown text={entry.text} />;
};

/** The heading each step of a consultation shows, naming the consulted role. */
const CONSULTATION_HEADINGS: Record<ConsultationStep['kind'], StringKey> = {
  asked: 'transcript.consultation.asked',
  answered: 'transcript.consultation.answered',
  failed: 'transcript.consultation.failed',
};

/**
 * One step of a consultation, set off like a quotation: the question asked,
 * then later the answer. A question still waiting says so. Each step offers
 * the consulted agent's own conversation, which opens only when asked for, so
 * following a consultation costs no stream until then (002.07).
 */
const ConsultationEntry = ({
  entry,
  step,
  waiting,
}: {
  readonly entry: LogEntry;
  readonly step: ConsultationStep;
  readonly waiting: boolean;
}) => {
  // Outside a chat provider (a test, a future surface) the link has nowhere
  // to open, so it is left out rather than failing.
  const chat = use(ChatContext);
  const role = { role: step.roleName };
  return (
    <li className="transcript__entry transcript__entry--consultation">
      <p className="transcript__meta">
        {t('transcript.entry.label', {
          time: entry.time,
          label: t(CONSULTATION_HEADINGS[step.kind], role),
        })}
      </p>
      <EntryBody entry={entry} />
      {waiting && (
        <p className="transcript__consultation-waiting">
          {t('transcript.consultation.waiting', role)}
        </p>
      )}
      {chat !== null && step.agentId !== '' && (
        <Button
          className="react-aria-Button transcript__consultation-open"
          onPress={() => {
            chat.openChat({
              agentId: step.agentId,
              roleName: step.roleName,
              reference: null,
              readOnly: true,
            });
          }}
        >
          {t('transcript.consultation.open', role)}
        </Button>
      )}
    </li>
  );
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
  // Consulted agents that have answered (or failed); any other question waits.
  const answered = new Set(
    entries.flatMap(({ consultation }) =>
      consultation !== undefined && consultation.kind !== 'asked'
        ? [consultation.agentId]
        : [],
    ),
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
          if (entry.consultation !== undefined) {
            return (
              <ConsultationEntry
                key={index}
                entry={entry}
                step={entry.consultation}
                waiting={
                  entry.consultation.kind === 'asked' &&
                  !answered.has(entry.consultation.agentId)
                }
              />
            );
          }
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
