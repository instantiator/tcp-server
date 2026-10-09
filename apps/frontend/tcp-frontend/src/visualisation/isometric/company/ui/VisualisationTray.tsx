import { Crosshair, X } from 'lucide-react';
import { forwardRef, useId } from 'react';
import { Button, ToggleButton } from 'react-aria-components';
import { Icon, WithTooltip } from '../../../../components/Icon/Icon';
import { t } from '../../../../strings';
import type { SelectionTarget } from '../TcpPhaserEventBus';
import { AgentDetails } from './AgentDetails';
import { ArchiveDetails } from './ArchiveDetails';
import { RoleDetails } from './RoleDetails';
import { TaskDetails } from './TaskDetails';

export interface VisualisationTrayProps {
  readonly companyId: string;
  readonly selection: SelectionTarget;
  readonly following: boolean;
  readonly onToggleFollow: () => void;
  readonly onClose: () => void;
  /** Where the close and follow tooltips are portalled; see `VisualisationToolbarProps.portalContainer`. */
  readonly portalContainer?: Element | undefined;
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
 *
 * The close button floats at the tray's own top-right corner (CSS); the
 * follow toggle travels with whichever `*Details` panel is showing, next to
 * its heading, via `TrayHeading` — both are built once here and handed down
 * or placed directly, rather than duplicated per selection kind.
 */
export const VisualisationTray = forwardRef<
  HTMLElement,
  VisualisationTrayProps
>(
  (
    {
      companyId,
      selection,
      following,
      onToggleFollow,
      onClose,
      portalContainer,
    },
    ref,
  ) => {
    const headingId = useId();
    const followLabel = t('visualisation.tray.follow');
    const closeLabel = t('visualisation.tray.close');

    const followAction = (
      <WithTooltip label={followLabel} portalContainer={portalContainer}>
        <ToggleButton
          className="react-aria-ToggleButton tcp-icon-button"
          aria-label={followLabel}
          isSelected={following}
          onChange={onToggleFollow}
        >
          <Icon icon={Crosshair} />
        </ToggleButton>
      </WithTooltip>
    );

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
            headingAction={followAction}
          />
        )}
        {selection.kind === 'task' && (
          <TaskDetails
            companyId={companyId}
            taskId={selection.id}
            headingId={headingId}
            headingAction={followAction}
            portalContainer={portalContainer}
          />
        )}
        {selection.kind === 'role' && (
          <RoleDetails
            companyId={companyId}
            roleId={selection.id}
            headingId={headingId}
            headingAction={followAction}
          />
        )}
        {selection.kind === 'archive' && (
          <ArchiveDetails
            companyId={companyId}
            headingId={headingId}
            headingAction={followAction}
          />
        )}
        <WithTooltip label={closeLabel} portalContainer={portalContainer}>
          <Button
            className="react-aria-Button tcp-icon-button tcp-icon-button--small company-visualisation__tray-close"
            aria-label={closeLabel}
            onPress={onClose}
          >
            <Icon icon={X} />
          </Button>
        </WithTooltip>
      </aside>
    );
  },
);

VisualisationTray.displayName = 'VisualisationTray';
