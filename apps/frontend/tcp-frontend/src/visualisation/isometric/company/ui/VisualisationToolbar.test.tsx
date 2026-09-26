import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { t } from '../../../../strings';
import { expectNoA11yViolations } from '../../../../test-support/axe';
import { PAN_STEP_PX, VisualisationToolbar } from './VisualisationToolbar';

describe('VisualisationToolbar', () => {
  const renderToolbar = (isFullscreen = false) => {
    const onSelect = vi.fn();
    const onPan = vi.fn();
    const onToggleFullscreen = vi.fn();
    const utils = render(
      <VisualisationToolbar
        snapshot={null}
        selection={null}
        onSelect={onSelect}
        onPan={onPan}
        isFullscreen={isFullscreen}
        onToggleFullscreen={onToggleFullscreen}
      />,
    );
    return { ...utils, onSelect, onPan, onToggleFullscreen };
  };

  it('pans left by one step on the negative x axis', async () => {
    const user = userEvent.setup();
    const { onPan } = renderToolbar();

    await user.click(
      screen.getByRole('button', { name: t('visualisation.pan.left') }),
    );

    expect(onPan).toHaveBeenCalledWith(-PAN_STEP_PX, 0);
  });

  it('pans right by one step on the positive x axis', async () => {
    const user = userEvent.setup();
    const { onPan } = renderToolbar();

    await user.click(
      screen.getByRole('button', { name: t('visualisation.pan.right') }),
    );

    expect(onPan).toHaveBeenCalledWith(PAN_STEP_PX, 0);
  });

  it('pans up by one step on the negative y axis', async () => {
    const user = userEvent.setup();
    const { onPan } = renderToolbar();

    await user.click(
      screen.getByRole('button', { name: t('visualisation.pan.up') }),
    );

    expect(onPan).toHaveBeenCalledWith(0, -PAN_STEP_PX);
  });

  it('pans down by one step on the positive y axis', async () => {
    const user = userEvent.setup();
    const { onPan } = renderToolbar();

    await user.click(
      screen.getByRole('button', { name: t('visualisation.pan.down') }),
    );

    expect(onPan).toHaveBeenCalledWith(0, PAN_STEP_PX);
  });

  it("reflects isFullscreen as the full screen toggle's pressed state", () => {
    renderToolbar(true);

    expect(
      screen.getByRole('button', { name: t('visualisation.fullscreen') }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('calls onToggleFullscreen when the full screen toggle is pressed', async () => {
    const user = userEvent.setup();
    const { onToggleFullscreen } = renderToolbar();

    await user.click(
      screen.getByRole('button', { name: t('visualisation.fullscreen') }),
    );

    expect(onToggleFullscreen).toHaveBeenCalledTimes(1);
  });

  it('has no accessibility violations', async () => {
    const { container } = renderToolbar();

    await expectNoA11yViolations(container);
  });
});
