import { useId, useState } from 'react';
import { Button } from 'react-aria-components';
import { useListChangeAnnouncement } from '../../../announce/useListChangeAnnouncement';
import { useLiveCompanyAgentsList } from '../../../api/hooks';
import { ACTIVE_AGENT_STATUSES, statusLabel } from '../../../api/statuses';
import { t } from '../../../strings';
import { ActivityList } from './ActivityList';
import { roleLabel, type ListProps } from './activity-list-utils';

/**
 * How much of an agent's prompt a row shows before it is clipped.
 *
 * A judgement call, not a measurement: roughly two lines at the width these
 * rows render at, which is enough to tell one agent's work from another's
 * without letting a several-paragraph brief push the rest of the list off the
 * screen. Re-tune it against the real layout rather than deriving it.
 */
const PROMPT_EXCERPT_LENGTH = 160;

/** The opening of a prompt, cut back to a word boundary where there is one. */
const excerptOf = (prompt: string): string => {
  const clipped = prompt.slice(0, PROMPT_EXCERPT_LENGTH);
  const lastSpace = clipped.lastIndexOf(' ');
  // Only a boundary at least halfway along is worth backing off to: a prompt
  // whose opening holds no space at all still has to be clipped somewhere.
  return lastSpace > PROMPT_EXCERPT_LENGTH / 2
    ? clipped.slice(0, lastSpace)
    : clipped;
};

interface AgentPromptProps {
  readonly prompt: string;
  /**
   * The agent's role. Names the control, so the several rows that carry one at
   * once are told apart rather than all reading "Expand" (WCAG 2.4.6) — the
   * same per-role naming `activity.chats.open` and `chat.complete` already use.
   */
  readonly role: string;
}

/**
 * An agent's prompt, clipped to an excerpt with a control that reveals the rest.
 *
 * The full text is **out of the DOM** until it is asked for, rather than
 * present and visually clipped: CSS truncation is invisible to a screen
 * reader, which would read the whole prompt regardless and lose the very
 * saving this exists to make. The excerpt is a real opening of the prompt, so
 * what is read and what is shown are the same thing.
 *
 * State lives here, per row, so a live cache patch to the list re-renders the
 * row without collapsing it: the `<li>` keyed by agent id keeps this instance
 * mounted across an update, and an expanded prompt does not snap shut every
 * time an agent's status changes.
 */
const AgentPrompt = ({ prompt, role }: AgentPromptProps) => {
  const [expanded, setExpanded] = useState(false);
  const promptId = useId();

  // Nothing to expand: a control over a prompt that already fits is a tab stop
  // that reveals nothing, and a row of them is noise for everyone.
  if (prompt.length <= PROMPT_EXCERPT_LENGTH) {
    return <p className="activity-list__row-detail">{prompt}</p>;
  }

  return (
    <>
      <p className="activity-list__row-detail" id={promptId}>
        {expanded
          ? prompt
          : t('activity.agents.prompt.truncated', {
              excerpt: excerptOf(prompt),
            })}
      </p>
      {/*
        After the text it extends, the way a "read more" reads. Source order
        alone would leave that relationship to proximity, which is nothing a
        screen reader conveys, so `aria-controls` states it and `aria-expanded`
        carries the state — the row simply grows, and nothing moves out from
        under the cursor (ADR-027).
      */}
      <Button
        className="react-aria-Button activity-list__row-expand"
        aria-expanded={expanded}
        aria-controls={promptId}
        onPress={() => {
          setExpanded((open) => !open);
        }}
      >
        {expanded
          ? t('activity.agents.prompt.collapse', { role })
          : t('activity.agents.prompt.expand', { role })}
      </Button>
    </>
  );
};

/**
 * Agents currently working. Rows are non-interactive — the MVP has no
 * assignment dialog for a row to open — apart from the prompt's own expander,
 * which acts on the row's text rather than opening anything.
 */
export const AgentsList = ({ companyId, roleNames }: ListProps) => {
  const query = useLiveCompanyAgentsList(companyId);
  // `some` rather than `includes`, so the literal-union constant needs no
  // widening cast to be compared against the schema's `string`.
  const rows = query.data?.filter((agent) =>
    ACTIVE_AGENT_STATUSES.some((active) => active === agent.status),
  );

  useListChangeAnnouncement(
    rows?.map((agent) => agent.id),
    {
      channel: 'agents',
      added: 'announce.agentsStarted',
      removed: 'announce.agentsFinished',
    },
  );

  return (
    <ActivityList
      heading={t('activity.agents.heading')}
      query={query}
      channel="agents"
      count={rows?.length ?? 0}
      emptyHeading={t('activity.agents.empty.heading')}
      emptyBody={t('activity.agents.empty.body')}
    >
      <ul className="activity-list__rows">
        {rows?.map((agent) => {
          const role = roleLabel(roleNames, agent.roleId);
          return (
            // Keyed by agent id, which is what lets an expanded prompt survive
            // a live patch to this list.
            <li className="activity-list__row" key={agent.id}>
              <p className="activity-list__row-title">{role}</p>
              <p className="activity-list__row-detail">
                {statusLabel(agent.status)}
              </p>
              <AgentPrompt prompt={agent.initialPrompt} role={role} />
            </li>
          );
        })}
      </ul>
    </ActivityList>
  );
};
