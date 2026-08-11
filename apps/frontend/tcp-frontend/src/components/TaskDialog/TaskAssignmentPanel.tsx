import { useId } from 'react';
import { Button } from 'react-aria-components';
import { statusLabel } from '../../api/statuses';
import { t } from '../../strings';
import { EmptyState } from '../EmptyState/EmptyState';
import { Transcript } from '../Transcript/Transcript';

export interface TaskAssignmentPanelProps {
  readonly agentId: string | null;
  readonly roleName: string;
  /** The assignment's own status, already live from the assignments list. */
  readonly status: string;
  readonly isExpanded: boolean;
  readonly onToggle: () => void;
}

/**
 * One assignment working a task: its role, its status, and — once expanded —
 * that agent's work as a transcript.
 *
 * **Collapsed by default, and the transcript unmounts when it is.** That is
 * what releases the assignment's event stream (rule 2 of the connection
 * budget, recorded above `MAX_STREAMS` in `src/events/subscriptions.ts`): a
 * collapsed panel is a parked surface, exactly like a minimised chat. Hiding
 * the transcript with CSS instead would keep its stream open for a panel the
 * user cannot see. Nothing moves focus when a panel toggles — it stays on the
 * button that was pressed.
 *
 * An assignment nobody has picked up yet has no `agentId` and so no
 * transcript to show.
 */
export const TaskAssignmentPanel = ({
  agentId,
  roleName,
  status,
  isExpanded,
  onToggle,
}: TaskAssignmentPanelProps) => {
  const headingId = useId();
  const bodyId = useId();

  return (
    <section className="task-assignment" aria-labelledby={headingId}>
      <h3 id={headingId} className="task-assignment__heading">
        {t('task.assignment.label', {
          role: roleName,
          status: statusLabel(status),
        })}
      </h3>
      <Button
        className="react-aria-Button task-assignment__toggle"
        aria-expanded={isExpanded}
        aria-controls={bodyId}
        onPress={onToggle}
      >
        {isExpanded
          ? t('task.assignment.collapse', { role: roleName })
          : t('task.assignment.expand', { role: roleName })}
      </Button>
      {isExpanded && (
        <div id={bodyId} className="task-assignment__body">
          {agentId === null ? (
            <EmptyState
              heading={t('task.assignment.noAgent.heading')}
              headingLevel={4}
            >
              {t('task.assignment.noAgent.body')}
            </EmptyState>
          ) : (
            <Transcript agentId={agentId} roleName={roleName} />
          )}
        </div>
      )}
    </section>
  );
};
