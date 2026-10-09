import { virtual } from '@guidepup/virtual-screen-reader';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import { AUTO_HIDE_MS } from './auto-hide';
import { Notification, type NotificationProps } from './Notification';

const MESSAGE = 'Draft the Q3 report failed';
const DURABLE_HREF = '/company/acme';

const renderNotification = (overrides: Partial<NotificationProps> = {}) =>
  render(
    <MemoryRouter>
      <Notification
        message={MESSAGE}
        durableHref={DURABLE_HREF}
        onDismiss={vi.fn()}
        channel="tasks"
        {...overrides}
      />
    </MemoryRouter>,
  );

describe('Notification', () => {
  it('names itself and says what happened', () => {
    renderNotification();

    expect(
      screen.getByRole('group', { name: t('notification.label') }),
    ).toHaveTextContent(MESSAGE);
  });

  it('makes its message a link to the durable row', () => {
    renderNotification();

    // WCAG 2.2.3, adopted by ADR-026: a toast that hides itself is never the
    // only record of an event. The link is what makes that true, and the prop
    // that supplies it is required so it cannot be forgotten.
    expect(screen.getByRole('link', { name: MESSAGE })).toHaveAttribute(
      'href',
      DURABLE_HREF,
    );
  });

  it('dismisses only when asked', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    renderNotification({ onDismiss });

    await user.click(
      screen.getByRole('button', { name: t('notification.dismiss') }),
    );

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  describe('over time', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(async () => {
      await virtual.stop();
      vi.useRealTimers();
    });

    it('hides itself after AUTO_HIDE_MS', async () => {
      const onDismiss = vi.fn();
      renderNotification({ onDismiss });

      await vi.advanceTimersByTimeAsync(AUTO_HIDE_MS - 500);
      expect(onDismiss).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      expect(onDismiss).toHaveBeenCalledOnce();
    });

    it('stops the timer while hovered and restarts it in full on leaving', async () => {
      const onDismiss = vi.fn();
      renderNotification({ onDismiss });
      const group = screen.getByRole('group', {
        name: t('notification.label'),
      });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      await vi.advanceTimersByTimeAsync(AUTO_HIDE_MS - 2000);
      await user.hover(group);
      await vi.advanceTimersByTimeAsync(AUTO_HIDE_MS * 2);
      expect(onDismiss).not.toHaveBeenCalled();

      await user.unhover(group);
      // The original deadline has long passed, and a partial restart would
      // have fired by now: only a full one is still waiting. The margins
      // absorb the fake clock's real-time drift (`shouldAdvanceTime`).
      await vi.advanceTimersByTimeAsync(AUTO_HIDE_MS - 500);
      expect(onDismiss).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(onDismiss).toHaveBeenCalledOnce();
    });

    it('stops the timer while focus is inside, and restarts it when focus leaves', async () => {
      const onDismiss = vi.fn();
      renderNotification({ onDismiss });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      await user.tab();
      expect(screen.getByRole('link', { name: MESSAGE })).toHaveFocus();
      await vi.advanceTimersByTimeAsync(AUTO_HIDE_MS * 2);
      expect(onDismiss).not.toHaveBeenCalled();

      // Moving between its own controls is not leaving.
      await user.tab();
      expect(
        screen.getByRole('button', { name: t('notification.dismiss') }),
      ).toHaveFocus();
      await vi.advanceTimersByTimeAsync(AUTO_HIDE_MS * 2);
      expect(onDismiss).not.toHaveBeenCalled();

      await user.tab();
      await vi.advanceTimersByTimeAsync(AUTO_HIDE_MS);
      expect(onDismiss).toHaveBeenCalledOnce();
    });

    it('is announced once, on appearance', async () => {
      await virtual.start({ container: document.body });
      await virtual.clearSpokenPhraseLog();

      renderNotification();
      await vi.advanceTimersByTimeAsync(1000);

      expect(await virtual.spokenPhraseLog()).toEqual([`polite: ${MESSAGE}`]);
    });

    it('interrupts when it carries a failure', async () => {
      await virtual.start({ container: document.body });
      await virtual.clearSpokenPhraseLog();

      renderNotification({ politeness: 'assertive' });
      await vi.advanceTimersByTimeAsync(1000);

      expect(await virtual.spokenPhraseLog()).toEqual([
        `assertive: ${MESSAGE}`,
      ]);
    });
  });

  it('has no accessibility violations', async () => {
    const { container } = renderNotification();

    await expectNoA11yViolations(container);
  });
});
