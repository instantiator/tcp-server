import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import { ConfirmDialog } from './ConfirmDialog';

const HEADING = 'Delete this chat?';

const renderConfirm = () => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <ConfirmDialog
      isOpen
      heading={HEADING}
      message="Its transcript is deleted too."
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { ...view, onConfirm, onCancel };
};

describe('ConfirmDialog', () => {
  it('is an alertdialog named by its question, with no close', () => {
    renderConfirm();
    expect(screen.getByRole('alertdialog', { name: HEADING })).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: t('dialog.close') }),
    ).toBeNull();
  });

  it('starts with focus on "no"', async () => {
    renderConfirm();
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: t('confirm.no') }),
      );
    });
  });

  it('confirms on "yes"', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderConfirm();
    await user.click(screen.getByRole('button', { name: t('confirm.yes') }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('treats "no" and escape alike', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderConfirm();
    await user.click(screen.getByRole('button', { name: t('confirm.no') }));
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('has no accessibility violations', async () => {
    renderConfirm();
    // The dialog is portalled, so the container would be empty.
    await expectNoA11yViolations(document.body);
  });
});
