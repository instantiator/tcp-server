import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Button } from 'react-aria-components';
import { describe, expect, it } from 'vitest';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import { Dialog } from './Dialog';

const HEADING = 'Chat with Sales';
const INNER_HEADING = 'Confirm';

/**
 * A trigger and the dialog it opens — the shape every consumer has, and the
 * only way to assert that focus goes back to the control that opened the
 * dialog rather than to the page body.
 */
const Harness = ({
  onMinimise,
  hideClose,
  children,
}: {
  onMinimise?: () => void;
  hideClose?: boolean;
  children?: React.ReactNode;
}) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <Button
        className="react-aria-Button"
        onPress={() => {
          setIsOpen(true);
        }}
      >
        Open
      </Button>
      <Dialog
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        heading={HEADING}
        onMinimise={onMinimise}
        hideClose={hideClose}
      >
        {children ?? <Button className="react-aria-Button">Do a thing</Button>}
      </Dialog>
    </>
  );
};

/** A dialog that opens a second dialog, for the stacking case. */
const StackedHarness = () => {
  const [innerOpen, setInnerOpen] = useState(false);

  return (
    <Harness>
      <Button
        className="react-aria-Button"
        onPress={() => {
          setInnerOpen(true);
        }}
      >
        Open inner
      </Button>
      <Dialog
        isOpen={innerOpen}
        onOpenChange={setInnerOpen}
        heading={INNER_HEADING}
      >
        <Button className="react-aria-Button">Inner action</Button>
      </Dialog>
    </Harness>
  );
};

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: 'Open' }));
};

describe('Dialog', () => {
  it('is labelled by its heading', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await open(user);

    expect(screen.getByRole('dialog', { name: HEADING })).toBeTruthy();
  });

  it('moves focus into the dialog on open', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await open(user);

    expect(
      screen
        .getByRole('dialog', { name: HEADING })
        .contains(document.activeElement),
    ).toBe(true);
  });

  it('returns focus to the control that opened it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    await open(user);

    await user.click(screen.getByRole('button', { name: t('dialog.close') }));

    expect(screen.queryByRole('dialog')).toBeNull();
    // React Aria restores focus after the dialog unmounts, not during it.
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });

  it('closes on escape', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await open(user);

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('traps focus while open', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await open(user);
    const dialog = screen.getByRole('dialog', { name: HEADING });

    // Enough tabs to leave any three-control dialog twice over. Focus must
    // still be inside it — outside the dialog is the page behind, which is
    // inert while a modal is open.
    for (let i = 0; i < 8; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('offers no minimise button unless the caller can park it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await open(user);

    expect(
      screen.queryByRole('button', { name: t('dialog.minimise') }),
    ).toBeNull();
  });

  it('offers a minimise button when the caller can park it', async () => {
    const user = userEvent.setup();
    render(<Harness onMinimise={() => undefined} />);
    await open(user);

    expect(
      screen.getByRole('button', { name: t('dialog.minimise') }),
    ).toBeTruthy();
  });

  it('hides its close button when the caller asks, without losing escape', async () => {
    const user = userEvent.setup();
    render(<Harness hideClose onMinimise={() => undefined} />);
    await open(user);

    expect(
      screen.queryByRole('button', { name: t('dialog.close') }),
    ).toBeNull();

    // The point of the prop is that one *control* goes, not that the dialog
    // becomes impossible to dismiss — a modal with no way out is the failure
    // this asserts against.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('hides the page behind it from assistive technology', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await open(user);

    // The trigger is still in the DOM, but a modal marks everything outside
    // itself `aria-hidden` — so the accessible tree cannot reach it.
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
  });

  describe('stacked', () => {
    it('shows both dialogs, and closing the inner one returns focus to the outer', async () => {
      const user = userEvent.setup();
      render(<StackedHarness />);
      await open(user);

      const innerTrigger = screen.getByRole('button', { name: 'Open inner' });
      await user.click(innerTrigger);
      expect(screen.getByRole('dialog', { name: INNER_HEADING })).toBeTruthy();

      // Two close buttons are on screen; the inner dialog's is the one the
      // accessible tree reaches from the inner dialog.
      const inner = screen.getByRole('dialog', { name: INNER_HEADING });
      // An icon button since 000.05, so it is found by its accessible name.
      const innerClose = Array.from(inner.querySelectorAll('button')).find(
        (button) => button.getAttribute('aria-label') === t('dialog.close'),
      );
      await user.click(innerClose as HTMLButtonElement);

      expect(screen.queryByRole('dialog', { name: INNER_HEADING })).toBeNull();
      expect(screen.getByRole('dialog', { name: HEADING })).toBeTruthy();
      // Restored after the inner dialog unmounts, not during it.
      await waitFor(() => {
        expect(document.activeElement).toBe(innerTrigger);
      });
    });
  });

  it('has no accessibility violations', async () => {
    const user = userEvent.setup();
    render(<Harness onMinimise={() => undefined} />);
    await open(user);

    // The dialog portals out of the render container, so the scan is of the
    // whole document — the same reason 003.02's menu tests scan `document.body`.
    await expectNoA11yViolations(document.body);
  });
});
