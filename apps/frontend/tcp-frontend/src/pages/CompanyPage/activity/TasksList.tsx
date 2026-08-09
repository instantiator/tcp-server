import { useState } from 'react';
import {
  CheckboxButton,
  CheckboxField,
  CheckboxGroup,
  Label,
} from 'react-aria-components';
import { useListChangeAnnouncement } from '../../../announce/useListChangeAnnouncement';
import { useLiveCompanyTasksList } from '../../../api/hooks';
import { ACTIVE_TASK_STATUSES } from '../../../api/statuses';
import { t } from '../../../strings';
import { ActivityList } from './ActivityList';
import { statusLabel } from './activity-list-utils';

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
  const query = useLiveCompanyTasksList(companyId);
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
