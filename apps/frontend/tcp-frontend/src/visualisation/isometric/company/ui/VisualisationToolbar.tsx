import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Maximize,
  Minimize,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import {
  Button,
  ToggleButton,
  Toolbar,
  Tooltip,
  TooltipTrigger,
} from 'react-aria-components';
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
}

/** An icon drawn inside a control. Decorative: the control carries the name. */
const Icon = ({ icon: Glyph }: { readonly icon: LucideIcon }) => (
  <Glyph className="company-visualisation__icon" aria-hidden="true" />
);

/**
 * A control whose face is only an icon, so its name is also shown as a
 * tooltip on hover or focus: a sighted user sees what the icon means, and
 * voice control and screen readers use the same words (WCAG 2.5.3).
 */
const WithTooltip = ({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) => (
  <TooltipTrigger>
    {children}
    <Tooltip className="react-aria-Tooltip">{label}</Tooltip>
  </TooltipTrigger>
);

interface PanButtonProps {
  readonly direction: 'left' | 'right' | 'up' | 'down';
  readonly icon: LucideIcon;
  readonly onPress: () => void;
}

const PanButton = ({ direction, icon, onPress }: PanButtonProps) => {
  const label = t(`visualisation.pan.${direction}`);
  return (
    <WithTooltip label={label}>
      <Button
        className={`react-aria-Button company-visualisation__pan-button company-visualisation__pan-button--${direction}`}
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
 */
export const VisualisationToolbar = ({
  snapshot,
  selection,
  onSelect,
  onPan,
  isFullscreen,
  onToggleFullscreen,
}: VisualisationToolbarProps) => {
  const fullscreenLabel = t('visualisation.fullscreen');
  return (
    <Toolbar
      aria-label={t('visualisation.toolbar.label')}
      className="react-aria-Toolbar company-visualisation__toolbar"
    >
      <div className="company-visualisation__pan">
        <PanButton
          direction="left"
          icon={ArrowLeft}
          onPress={() => {
            onPan(-PAN_STEP_PX, 0);
          }}
        />
        <PanButton
          direction="right"
          icon={ArrowRight}
          onPress={() => {
            onPan(PAN_STEP_PX, 0);
          }}
        />
        <PanButton
          direction="up"
          icon={ArrowUp}
          onPress={() => {
            onPan(0, -PAN_STEP_PX);
          }}
        />
        <PanButton
          direction="down"
          icon={ArrowDown}
          onPress={() => {
            onPan(0, PAN_STEP_PX);
          }}
        />
      </div>
      <WithTooltip label={fullscreenLabel}>
        <ToggleButton
          className="react-aria-ToggleButton company-visualisation__icon-button"
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
      />
    </Toolbar>
  );
};
