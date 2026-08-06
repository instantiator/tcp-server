import { virtual } from '@guidepup/virtual-screen-reader';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import { Notification, type NotificationProps } from './Notification';

const MESSAGE = 'Draft the Q3 report failed';
const DURABLE_HREF = '/company/acme';
const DURABLE_LABEL = 'Acme activity';

const renderNotification = (overrides: Partial<NotificationProps> = {}) =>
  render(
    <MemoryRouter>
      <Notification
        message={MESSAGE}
        durableHref={DURABLE_HREF}
        durableLabel={DURABLE_LABEL}
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

  it('points at somewhere the same information lives permanently', () => {
    renderNotification();

    // WCAG 2.2.3, adopted by ADR-026: a notification is never the only record
    // of an event. The link is what makes that true, and the prop that
    // supplies it is required so it cannot be forgotten.
    expect(screen.getByRole('link', { name: DURABLE_LABEL })).toHaveAttribute(
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

    it('never disappears on its own', async () => {
      renderNotification();

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      // An hour later it is still there. Content that conveys information and
      // then removes itself fails WCAG 2.2.3, and takes the only notice of
      // the event with it.
      expect(screen.getByText(MESSAGE)).toBeInTheDocument();
    });

    it('is announced once, on appearance', async () => {
      await virtual.start({ container: document.body });
      await virtual.clearSpokenPhraseLog();

      renderNotification();
      await vi.advanceTimersByTimeAsync(1);

      expect(await virtual.spokenPhraseLog()).toEqual([`polite: ${MESSAGE}`]);
    });

    it('interrupts when it carries a failure', async () => {
      await virtual.start({ container: document.body });
      await virtual.clearSpokenPhraseLog();

      renderNotification({ politeness: 'assertive' });
      await vi.advanceTimersByTimeAsync(1);

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
