import { virtual } from '@guidepup/virtual-screen-reader';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANNOUNCE_THROTTLE_MS } from '../../announce/announcer';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import { LoadingState } from './LoadingState';

const LABEL = 'Companies';

describe('LoadingState', () => {
  it('exposes the wait as an indeterminate progress bar', () => {
    render(<LoadingState label={LABEL} />);

    const bar = screen.getByRole('progressbar', {
      name: t('state.loading', { label: LABEL }),
    });
    // Indeterminate: no value to report, because nothing knows how long
    // this takes. A progress bar claiming 0% would be a lie.
    expect(bar).not.toHaveAttribute('aria-valuenow');
  });

  it('mounts no live region of its own', () => {
    const { container } = render(<LoadingState label={LABEL} />);

    // ADR-027 allows exactly one announcer in this application. A spinner
    // that carried its own region would announce itself on mount, which is
    // both wrong and invisible to a test that only asserts on the role.
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

    it('says nothing when a wait begins', async () => {
      await virtual.start({ container: document.body });
      await virtual.clearSpokenPhraseLog();

      render(<LoadingState label={LABEL} />);
      await vi.advanceTimersByTimeAsync(ANNOUNCE_THROTTLE_MS * 2);

      // Completion is announced by `useLoadingAnnouncement`, from the surface
      // that owns the data. Starting is never announced at all.
      expect(await virtual.spokenPhraseLog()).toEqual([]);
    });
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<LoadingState label={LABEL} />);

    await expectNoA11yViolations(container);
  });
});
