import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useState } from 'react';
import { Button } from 'react-aria-components';
import { describe, expect, it, vi } from 'vitest';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import { Dialog } from './Dialog';
import { DockProvider } from './DockProvider';
import { useDock } from './useDock';

const HEADING = 'Chat with Sales';
const DOCK_LABEL = 'Sales';

/**
 * A dialog that minimises to the dock and comes back — the shape 008.02 will
 * use. The dialog's own state (here, the typed message) lives in the caller,
 * which is what makes unmounting the modal safe.
 */
const Harness = () => {
  const dock = useDock();
  const [isOpen, setIsOpen] = useState(true);

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      heading={HEADING}
      onMinimise={() => {
        setIsOpen(false);
        dock.minimise({
          id: 'sales',
          label: DOCK_LABEL,
          restore: () => {
            setIsOpen(true);
          },
        });
      }}
    >
      <Button className="react-aria-Button">Send</Button>
    </Dialog>
  );
};

const renderDock = () =>
  render(
    <DockProvider>
      <Harness />
    </DockProvider>,
  );

describe('DockProvider', () => {
  it('renders no bar until something is minimised', () => {
    render(
      <DockProvider>
        <p>Nothing docked</p>
      </DockProvider>,
    );

    expect(
      screen.queryByRole('navigation', { name: t('dock.label') }),
    ).toBeNull();
  });

  it('unmounts the dialog and parks it in the bar', async () => {
    const user = userEvent.setup();
    renderDock();

    await user.click(
      screen.getByRole('button', { name: t('dialog.minimise') }),
    );

    // The modal is gone, not hidden: a mounted modal keeps its focus trap and
    // keeps the page behind it inert.
    expect(screen.queryByRole('dialog')).toBeNull();
    const bar = screen.getByRole('navigation', { name: t('dock.label') });
    expect(bar.contains(screen.getByRole('button', { name: DOCK_LABEL }))).toBe(
      true,
    );
  });

  it('restores the dialog from the keyboard', async () => {
    const user = userEvent.setup();
    renderDock();
    await user.click(
      screen.getByRole('button', { name: t('dialog.minimise') }),
    );

    screen.getByRole('button', { name: DOCK_LABEL }).focus();
    await user.keyboard('{Enter}');

    expect(screen.getByRole('dialog', { name: HEADING })).toBeTruthy();
    expect(
      screen.queryByRole('navigation', { name: t('dock.label') }),
    ).toBeNull();
  });

  it('restores once under StrictMode, not twice', async () => {
    const user = userEvent.setup();
    const restore = vi.fn();

    const Minimiser = () => {
      const dock = useDock();
      return (
        <>
          <Button
            className="react-aria-Button"
            onPress={() => {
              dock.minimise({ id: 'sales', label: DOCK_LABEL, restore });
            }}
          >
            Park it
          </Button>
        </>
      );
    };

    render(
      <StrictMode>
        <DockProvider>
          <Minimiser />
        </DockProvider>
      </StrictMode>,
    );
    await user.click(screen.getByRole('button', { name: 'Park it' }));
    await user.click(screen.getByRole('button', { name: DOCK_LABEL }));

    // `restore` runs outside the state updater precisely so StrictMode's
    // double invocation cannot re-open the dialog twice.
    expect(restore).toHaveBeenCalledOnce();
  });

  it('docks the same dialog once however often it is minimised', async () => {
    const user = userEvent.setup();
    renderDock();

    await user.click(
      screen.getByRole('button', { name: t('dialog.minimise') }),
    );
    await user.click(screen.getByRole('button', { name: DOCK_LABEL }));
    await user.click(
      screen.getByRole('button', { name: t('dialog.minimise') }),
    );

    expect(screen.getAllByRole('button', { name: DOCK_LABEL })).toHaveLength(1);
  });

  it('has no accessibility violations', async () => {
    const user = userEvent.setup();
    renderDock();
    await user.click(
      screen.getByRole('button', { name: t('dialog.minimise') }),
    );

    await expectNoA11yViolations(document.body);
  });
});
