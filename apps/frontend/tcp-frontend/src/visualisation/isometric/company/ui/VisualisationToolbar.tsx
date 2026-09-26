import { Button, ToggleButton, Toolbar } from 'react-aria-components';
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

/**
 * The office view's on-screen controls: pan, full screen, and the keyboard
 * route into the tray (`DetailsPicker`). Keyboard panning itself is handled
 * by the stage that hosts this toolbar, not here — these buttons are a
 * pointer-friendly duplicate of the same four directions.
 */
export const VisualisationToolbar = ({
  snapshot,
  selection,
  onSelect,
  onPan,
  isFullscreen,
  onToggleFullscreen,
}: VisualisationToolbarProps) => (
  <Toolbar
    aria-label={t('visualisation.toolbar.label')}
    className="react-aria-Toolbar company-visualisation__toolbar"
  >
    <Button
      onPress={() => {
        onPan(-PAN_STEP_PX, 0);
      }}
    >
      {t('visualisation.pan.left')}
    </Button>
    <Button
      onPress={() => {
        onPan(PAN_STEP_PX, 0);
      }}
    >
      {t('visualisation.pan.right')}
    </Button>
    <Button
      onPress={() => {
        onPan(0, -PAN_STEP_PX);
      }}
    >
      {t('visualisation.pan.up')}
    </Button>
    <Button
      onPress={() => {
        onPan(0, PAN_STEP_PX);
      }}
    >
      {t('visualisation.pan.down')}
    </Button>
    <ToggleButton isSelected={isFullscreen} onChange={onToggleFullscreen}>
      {t('visualisation.fullscreen')}
    </ToggleButton>
    <DetailsPicker
      snapshot={snapshot}
      selection={selection}
      onSelect={onSelect}
    />
  </Toolbar>
);
