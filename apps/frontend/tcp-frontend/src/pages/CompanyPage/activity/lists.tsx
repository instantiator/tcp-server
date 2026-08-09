import { useState } from 'react';
import {
  CheckboxButton,
  CheckboxField,
  CheckboxGroup,
  Label,
} from 'react-aria-components';
import { ANNOUNCE_IMMEDIATE_MS } from '../../../announce/announcer';
import { useListChangeAnnouncement } from '../../../announce/useListChangeAnnouncement';
import {
  useAgents,
  useAssignments,
  useConversations,
  useTasks,
} from '../../../api/queries';
import {
  ACTIVE_AGENT_STATUSES,
  ACTIVE_ASSIGNMENT_STATUSES,
  ACTIVE_TASK_STATUSES,
} from '../../../api/statuses';
import { t, type StringKey } from '../../../strings';
import { ActivityList } from './ActivityList';

/**
 * The four activity lists, and the filter that narrows one of them.
 *
 * Each list is thin on purpose: call its hook, filter to the rows worth
 * showing, announce what changed, and hand the rows to {@link ActivityList},
 * which owns loading, error and empty presentation for all four.
 */

/** Props shared by the three lists that show a role name. */
interface ListProps {
  readonly companyId: string;
  /** Role id to display name. Agent and assignment rows carry only a `roleId`. */
  readonly roleNames: ReadonlyMap<string, string>;
}

// Every status a task, agent or assignment row can carry, mapped to its
// string key. A `Record` lookup rather than a template-literal key: the
// latter would type as `string`, not `StringKey`, and require a cast to pass
// to `t` — this stays honest under `strict` with none.
const STATUS_KEYS: Record<string, StringKey> = {
  ready: 'activity.status.ready',
  planning: 'activity.status.planning',
  'in-progress': 'activity.status.in-progress',
  finalising: 'activity.status.finalising',
  succeeded: 'activity.status.succeeded',
  failed: 'activity.status.failed',
  cancelled: 'activity.status.cancelled',
  idle: 'activity.status.idle',
  running: 'activity.status.running',
  paused: 'activity.status.paused',
  completed: 'activity.status.completed',
  'in-qa': 'activity.status.in-qa',
};

/** The user's word for a status, falling back rather than printing a schema value. */
const statusLabel = (status: string): string => {
  const key = STATUS_KEYS[status];
  return key === undefined ? t('activity.status.unknown') : t(key);
};

/**
 * Agents currently working. Rows are non-interactive — the MVP has no
 * assignment dialog for a row to open — so each is plain text, not a link
 * or a button.
 */
export const AgentsList = ({ companyId, roleNames }: ListProps) => {
  const query = useAgents({ companyId });
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
        {rows?.map((agent) => (
          // Non-interactive: no assignment dialog exists in the MVP.
          <li className="activity-list__row" key={agent.id}>
            <p className="activity-list__row-title">
              {roleNames.get(agent.roleId) ?? t('activity.role.unknown')}
            </p>
            <p className="activity-list__row-detail">
              {statusLabel(agent.status)}
            </p>
            <p className="activity-list__row-detail">{agent.initialPrompt}</p>
          </li>
        ))}
      </ul>
    </ActivityList>
  );
};

const TASK_STATUSES = [
  'ready',
  'planning',
  'in-progress',
  'finalising',
  'succeeded',
  'failed',
  'cancelled',
] as const;

interface TaskStatusFilterProps {
  readonly selected: string[];
  readonly onChange: (value: string[]) => void;
}

/**
 * The status filter over {@link TasksList}.
 *
 * `CheckboxField` + `CheckboxButton` rather than `Checkbox`, which React Aria
 * 1.20 deprecates exactly as it deprecates `Radio` — see `ThemeControl`'s note
 * on the same trade for radios. The pair renders the same shape, so
 * `styles/base.css` selects on `.react-aria-CheckboxButton`.
 */
const TaskStatusFilter = ({ selected, onChange }: TaskStatusFilterProps) => (
  <div className="activity-filter">
    {/*
      Passing `className` to a React Aria component replaces its default class
      rather than composing with it, so the library's own class name is
      repeated here — drop it and every rule in `styles/base.css` stops
      applying, silently.
    */}
    <CheckboxGroup
      className="react-aria-CheckboxGroup activity-filter__group"
      value={selected}
      onChange={onChange}
    >
      <Label>{t('activity.filter.label')}</Label>
      {TASK_STATUSES.map((status) => (
        <CheckboxField key={status} value={status}>
          <CheckboxButton>{statusLabel(status)}</CheckboxButton>
        </CheckboxField>
      ))}
    </CheckboxGroup>
  </div>
);

/**
 * Tasks in flight, narrowed by {@link TaskStatusFilter}. Rows are
 * non-interactive for now; 008.03 adds the task dialog.
 */
export const TasksList = ({ companyId }: { readonly companyId: string }) => {
  const [selected, setSelected] = useState<string[]>([...ACTIVE_TASK_STATUSES]);
  const query = useTasks({ companyId });
  const rows = query.data?.filter((task) => selected.includes(task.status));

  useListChangeAnnouncement(
    rows?.map((task) => task.id),
    {
      channel: 'tasks',
      added: 'announce.tasksAdded',
      removed: 'announce.tasksCompleted',
      // Reseeds the hook when the filter changes, so narrowing it does not read
      // as a mass arrival or departure of tasks — the user did that, they are
      // looking at it, and announcing it would describe their own keystroke
      // back to them.
      resetKey: selected.join(' '),
    },
  );

  return (
    <ActivityList
      heading={t('activity.tasks.heading')}
      query={query}
      channel="tasks"
      count={rows?.length ?? 0}
      emptyHeading={t('activity.tasks.empty.heading')}
      emptyBody={t('activity.tasks.empty.body')}
      // Inside the region, above the rows: the filter belongs to this list, and
      // rendering it as a sibling would leave that relationship to proximity
      // alone. It stays outside the busy area — a control over the content is
      // not part of it, and must not be replaced by the spinner.
      controls={<TaskStatusFilter selected={selected} onChange={setSelected} />}
    >
      <ul className="activity-list__rows">
        {rows?.map((task) => (
          // Non-interactive for now; 008.03 adds the task dialog.
          <li className="activity-list__row" key={task.id}>
            <p className="activity-list__row-title">{task.shortcode}</p>
            <p className="activity-list__row-detail">{task.request}</p>
            <p className="activity-list__row-detail">
              {statusLabel(task.status)}
            </p>
            {/*
              Deliberately no `completedSteps`/`totalSteps`: they exist on the
              stream summary, not on this REST row, so they would be absent on
              first paint and only materialise after the first event. Do not
              add them here.
            */}
          </li>
        ))}
      </ul>
    </ActivityList>
  );
};

/**
 * Open consultations — assignments in `consultee` mode with no task, per
 * ADR-023. Rows are non-interactive: no assignment dialog exists in the MVP.
 */
export const ConsultationsList = ({ companyId, roleNames }: ListProps) => {
  const query = useAssignments({
    companyId,
    // The literal four-character string 'null', not JS `null`: the server's
    // AssignmentController tests `taskId === 'null'` and maps it to
    // `IsNull()`. Omitting the parameter would mean "any task" instead of
    // "no task" — this looks like a bug and is not one.
    taskId: 'null',
    mode: 'consultee',
  });
  const rows = query.data?.filter((assignment) =>
    ACTIVE_ASSIGNMENT_STATUSES.some((active) => active === assignment.status),
  );

  useListChangeAnnouncement(
    rows?.map((assignment) => assignment.id),
    {
      channel: 'consultations',
      added: 'announce.consultationsOpened',
      removed: 'announce.consultationsClosed',
    },
  );

  return (
    <ActivityList
      heading={t('activity.consultations.heading')}
      query={query}
      channel="consultations"
      count={rows?.length ?? 0}
      emptyHeading={t('activity.consultations.empty.heading')}
      emptyBody={t('activity.consultations.empty.body')}
      // ADR-023: this list is consultee assignments that have been picked up,
      // so it is an approximation and must not present itself as complete.
      note={t('activity.consultations.partial')}
    >
      <ul className="activity-list__rows">
        {rows?.map((assignment) => (
          // Non-interactive: no assignment dialog exists in the MVP.
          <li className="activity-list__row" key={assignment.id}>
            <p className="activity-list__row-title">
              {roleNames.get(assignment.roleId) ?? t('activity.role.unknown')}
            </p>
            <p className="activity-list__row-detail">
              {statusLabel(assignment.status)}
            </p>
          </li>
        ))}
      </ul>
    </ActivityList>
  );
};

/** Conversations awaiting a person's reply. */
export interface EnquiriesListProps {
  readonly companyId: string;
}

/**
 * Enquiries an agent is waiting on a person to answer. Rows are
 * non-interactive for now; 008.04 adds the user response dialog.
 */
export const EnquiriesList = ({ companyId }: EnquiriesListProps) => {
  const query = useConversations({
    companyId,
    status: 'awaiting_user',
  });
  // Filtered again here, client-side, in addition to the `?status=` query: a
  // live event patches a closed enquiry's status in place rather than
  // removing its row, so the query's own filter only describes what was true
  // when it was fetched.
  const rows = query.data?.filter(
    (conversation) => conversation.status === 'awaiting_user',
  );

  useListChangeAnnouncement(
    rows?.map((conversation) => conversation.id),
    {
      // Its own channel, spoken immediately: ADR-027 wants a new enquiry
      // announced individually, and a channel's interval is set by whichever
      // announcement opens its window — folding this into a shared list channel
      // would make a new enquiry wait behind ten seconds of that list's chatter.
      channel: 'enquiry',
      added: 'announce.enquiryNew',
      throttleMs: ANNOUNCE_IMMEDIATE_MS,
    },
  );

  return (
    <ActivityList
      heading={t('activity.enquiries.heading')}
      query={query}
      channel="enquiry"
      count={rows?.length ?? 0}
      emptyHeading={t('activity.enquiries.empty.heading')}
      emptyBody={t('activity.enquiries.empty.body')}
    >
      <ul className="activity-list__rows">
        {rows?.map((conversation) => (
          // Non-interactive for now; 008.04 adds the user response dialog.
          <li className="activity-list__row" key={conversation.id}>
            <p className="activity-list__row-title">{conversation.roleName}</p>
            <p className="activity-list__row-detail">{conversation.question}</p>
          </li>
        ))}
      </ul>
    </ActivityList>
  );
};
