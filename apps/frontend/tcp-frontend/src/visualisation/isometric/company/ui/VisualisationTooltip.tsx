import { t } from '../../../../strings';
import type { CompanySnapshot } from '../rules/companySnapshot';
import type { HoverEvent } from '../TcpPhaserEventBus';

export interface VisualisationTooltipProps {
  readonly hover: HoverEvent | null;
  readonly snapshot: CompanySnapshot | null;
}

/**
 * The office's hover tooltip: what the pointer is over, in the snapshot's own
 * words. It reads the snapshot only — no request of its own — so it can
 * render the instant a `hover` event arrives.
 *
 * Renders nothing for a null hover, a null snapshot, or a target the
 * snapshot no longer has (an avatar or task room that has just gone).
 */
export const VisualisationTooltip = ({
  hover,
  snapshot,
}: VisualisationTooltipProps) => {
  if (hover === null || snapshot === null) return null;

  const { target, x, y } = hover;

  if (target.kind === 'role') {
    const role = snapshot.roles.find((candidate) => candidate.id === target.id);
    if (role === undefined) return null;
    return (
      <div
        role="tooltip"
        className="company-visualisation__tooltip"
        style={{ left: x, top: y }}
      >
        {t('visualisation.tooltip.role', { role: role.name })}
      </div>
    );
  }

  if (target.kind === 'agent') {
    const agent = snapshot.agents.find(
      (candidate) => candidate.id === target.id,
    );
    if (agent === undefined) return null;
    const roleName =
      snapshot.roles.find((candidate) => candidate.id === agent.roleId)?.name ??
      t('activity.role.unknown');
    return (
      <div
        role="tooltip"
        className="company-visualisation__tooltip"
        style={{ left: x, top: y }}
      >
        {t('visualisation.tooltip.agent', { role: roleName })}
      </div>
    );
  }

  const task = snapshot.tasks.find((candidate) => candidate.id === target.id);
  if (task === undefined) return null;
  return (
    <div
      role="tooltip"
      className="company-visualisation__tooltip"
      style={{ left: x, top: y }}
    >
      <p>
        {t('visualisation.tooltip.task', {
          step: task.step,
          steps: task.steps,
        })}
      </p>
      <p>{task.request}</p>
    </div>
  );
};
