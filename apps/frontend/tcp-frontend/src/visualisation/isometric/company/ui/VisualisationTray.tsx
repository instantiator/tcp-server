import { forwardRef, useId } from 'react';
import { Button, ToggleButton } from 'react-aria-components';
import { t } from '../../../../strings';
import type { SelectionTarget } from '../TcpPhaserEventBus';
import { AgentDetails } from './AgentDetails';
import { RoleDetails } from './RoleDetails';
import { TaskDetails } from './TaskDetails';

export interface VisualisationTrayProps {
  readonly companyId: string;
  readonly selection: SelectionTarget;
  readonly following: boolean;
  readonly onToggleFollow: () => void;
  readonly onClose: () => void;
}

/**
 * The live detail panel for whatever is selected in the office: a role, a
 * task or an agent.
 *
 * **Not a dialog.** The scene behind it stays interactive, nothing here traps
 * focus, and nothing moves focus when it opens or closes — a later step owns
 * that decision. There is no live region either: the panels below read from
 * live query data and simply re-render, which is browsing, not an
 * announcement.
 */
export const VisualisationTray = forwardRef<
  HTMLElement,
  VisualisationTrayProps
>(({ companyId, selection, following, onToggleFollow, onClose }, ref) => {
  const headingId = useId();

  return (
    <aside
      className="company-visualisation__tray"
      aria-labelledby={headingId}
      ref={ref}
    >
      {selection.kind === 'agent' && (
        <AgentDetails
          companyId={companyId}
          agentId={selection.id}
          headingId={headingId}
        />
      )}
      {selection.kind === 'task' && (
        <TaskDetails
          companyId={companyId}
          taskId={selection.id}
          headingId={headingId}
        />
      )}
      {selection.kind === 'role' && (
        <RoleDetails
          companyId={companyId}
          roleId={selection.id}
          headingId={headingId}
        />
      )}
      <ToggleButton isSelected={following} onChange={onToggleFollow}>
        {t('visualisation.tray.follow')}
      </ToggleButton>
      <Button onPress={onClose}>{t('visualisation.tray.close')}</Button>
    </aside>
  );
});

VisualisationTray.displayName = 'VisualisationTray';
