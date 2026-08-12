import { virtual } from '@guidepup/virtual-screen-reader';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import { ErrorState } from './ErrorState';

const MESSAGE = 'Companies could not be loaded';
const CHANNEL = 'companies';

describe('ErrorState', () => {
  it('names the failure and shows what went wrong', () => {
    render(<ErrorState message={MESSAGE} channel={CHANNEL} />);

    const group = screen.getByRole('group', { name: t('state.error.label') });
    expect(group).toHaveTextContent(MESSAGE);
  });

  it('offers a retry only when there is something to retry', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();

    const { rerender } = render(
      <ErrorState message={MESSAGE} channel={CHANNEL} />,
    );
    expect(
      screen.queryByRole('button', { name: t('state.error.retry') }),
    ).toBeNull();

    rerender(
      <ErrorState message={MESSAGE} channel={CHANNEL} onRetry={onRetry} />,
    );
    await user.click(
      screen.getByRole('button', { name: t('state.error.retry') }),
    );

    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('mounts no live region of its own', () => {
    const { container } = render(
      <ErrorState message={MESSAGE} channel={CHANNEL} />,
    );

    // The visible half stays in context; the spoken half goes through the one
    // announcer. `role="alert"` would be a second region — see the component.
    expect(
      container.querySelector(
        '[aria-live], [role="status"], [role="alert"], [role="log"]',
      ),
    ).toBeNull();
  });

  describe('speech', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(async () => {
      await virtual.stop();
      vi.useRealTimers();
    });

    it('interrupts, because a failure needs the user to act', async () => {
      await virtual.start({ container: document.body });
      await virtual.clearSpokenPhraseLog();

      render(<ErrorState message={MESSAGE} channel={CHANNEL} />);
      await vi.advanceTimersByTimeAsync(1);

      expect(await virtual.spokenPhraseLog()).toEqual([
        `assertive: ${t('state.error.announcement', { message: MESSAGE })}`,
      ]);
    });

    it('announces once under StrictMode, not twice', async () => {
      await virtual.start({ container: document.body });
      await virtual.clearSpokenPhraseLog();

      render(
        <StrictMode>
          <ErrorState message={MESSAGE} channel={CHANNEL} />
        </StrictMode>,
      );
      await vi.advanceTimersByTimeAsync(1);

      // The announcer counts repeats, so a run-count guard spent by
      // StrictMode's first invocation would say the message twice.
      expect(await virtual.spokenPhraseLog()).toEqual([
        `assertive: ${t('state.error.announcement', { message: MESSAGE })}`,
      ]);
    });

    it('does not re-announce an unchanged failure on re-render', async () => {
      await virtual.start({ container: document.body });
      await virtual.clearSpokenPhraseLog();

      const { rerender } = render(
        <ErrorState message={MESSAGE} channel={CHANNEL} />,
      );
      await vi.advanceTimersByTimeAsync(1);
      rerender(
        <ErrorState message={MESSAGE} channel={CHANNEL} onRetry={vi.fn()} />,
      );
      await vi.advanceTimersByTimeAsync(1);

      expect(await virtual.spokenPhraseLog()).toHaveLength(1);
    });
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <ErrorState message={MESSAGE} channel={CHANNEL} onRetry={vi.fn()} />,
    );

    await expectNoA11yViolations(container);
  });
});
