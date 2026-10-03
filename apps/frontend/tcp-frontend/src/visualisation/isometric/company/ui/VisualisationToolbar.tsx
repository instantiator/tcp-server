import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Maximize,
  Minimize,
  type LucideIcon,
} from 'lucide-react';
import { Button, ToggleButton, Toolbar } from 'react-aria-components';
import { Icon, WithTooltip } from '../../../../components/Icon/Icon';
import { t } from '../../../../strings';
import type { CompanySnapshot } from '../rules/companySnapshot';
import type { SelectionTarget } from '../TcpPhaserEventBus';
import { DetailsPicker } from './DetailsPicker';

/**
 * How far one press of a pan button moves the camera, in screen pixels.
 * Exported so a test can assert against the same value the buttons use,
 * rather than a copy that could drift from it. Not a component, so it needs
 * an explicit disable below rather than living in a file of its own.
 */
// eslint-disable-next-line react-refresh/only-export-components -- see above
export const PAN_STEP_PX = 64;

export interface VisualisationToolbarProps {
  readonly snapshot: CompanySnapshot | null;
  readonly selection: SelectionTarget | null;
  readonly onSelect: (target: SelectionTarget) => void;
  readonly onPan: (dx: number, dy: number) => void;
  readonly isFullscreen: boolean;
  readonly onToggleFullscreen: () => void;
  /**
   * Where the toolbar's tooltips and the picker's list are portalled: the
   * office view itself, rather than `document.body`. In full screen only the
   * full-screen element is drawn, so an overlay on the body would never
   * show; and inside the view it stays within the page's landmarks.
   */
  readonly portalContainer?: Element | undefined;
}

interface PanButtonProps {
  readonly direction: 'left' | 'right' | 'up' | 'down';
  readonly portalContainer: Element | undefined;
  readonly icon: LucideIcon;
  readonly onPress: () => void;
}

const PanButton = ({
  direction,
  portalContainer,
  icon,
  onPress,
}: PanButtonProps) => {
  const label = t(`visualisation.pan.${direction}`);
  return (
    <WithTooltip label={label} portalContainer={portalContainer}>
      <Button
        className={`react-aria-Button tcp-icon-button company-visualisation__pan-button company-visualisation__pan-button--${direction}`}
        aria-label={label}
        onPress={onPress}
      >
        <Icon icon={icon} />
      </Button>
    </WithTooltip>
  );
};

/**
 * The office view's on-screen controls: pan, full screen, and the keyboard
 * route into the tray (`DetailsPicker`). Keyboard panning itself is handled
 * by the stage that hosts this toolbar, not here — these buttons are a
 * pointer-friendly duplicate of the same four directions, laid out like a
 * keyboard's arrow keys. Their source order stays left, right, up, down, so
 * the toolbar's arrow-key movement between controls is unchanged.
 *
 * Floats over the bottom-left of the stage (005.01) rather than sitting
 * above it in the page's flow — `.tcp-floating` gives it its surface, and
 * `CompanyVisualisation.css` positions it against the office view's own
 * `position: relative`, since this renders before the stage in the DOM.
 */
export const VisualisationToolbar = ({
  snapshot,
  selection,
  onSelect,
  onPan,
  isFullscreen,
  onToggleFullscreen,
  portalContainer,
}: VisualisationToolbarProps) => {
  const fullscreenLabel = t('visualisation.fullscreen');
  return (
    <Toolbar
      aria-label={t('visualisation.toolbar.label')}
      className="react-aria-Toolbar tcp-floating company-visualisation__toolbar"
    >
      <div className="company-visualisation__pan">
        <PanButton
          portalContainer={portalContainer}
          direction="left"
          icon={ArrowLeft}
          onPress={() => {
            onPan(-PAN_STEP_PX, 0);
          }}
        />
        <PanButton
          portalContainer={portalContainer}
          direction="right"
          icon={ArrowRight}
          onPress={() => {
            onPan(PAN_STEP_PX, 0);
          }}
        />
        <PanButton
          portalContainer={portalContainer}
          direction="up"
          icon={ArrowUp}
          onPress={() => {
            onPan(0, -PAN_STEP_PX);
          }}
        />
        <PanButton
          portalContainer={portalContainer}
          direction="down"
          icon={ArrowDown}
          onPress={() => {
            onPan(0, PAN_STEP_PX);
          }}
        />
      </div>
      <WithTooltip label={fullscreenLabel} portalContainer={portalContainer}>
        <ToggleButton
          className="react-aria-ToggleButton tcp-icon-button"
          aria-label={fullscreenLabel}
          isSelected={isFullscreen}
          onChange={onToggleFullscreen}
        >
          <Icon icon={isFullscreen ? Minimize : Maximize} />
        </ToggleButton>
      </WithTooltip>
      <DetailsPicker
        snapshot={snapshot}
        selection={selection}
        onSelect={onSelect}
        portalContainer={portalContainer}
      />
    </Toolbar>
  );
};
