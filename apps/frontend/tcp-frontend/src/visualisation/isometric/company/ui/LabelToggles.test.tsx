import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { t } from '../../../../strings';
import { expectNoA11yViolations } from '../../../../test-support/axe';
import { LabelTogglesControl } from './LabelToggles';

describe('LabelTogglesControl', () => {
  it('offers one named checkbox per kind of label, in a labelled group', () => {
    render(<LabelTogglesControl value={[]} onChange={vi.fn()} />);

    expect(
      screen.getByRole('group', { name: t('visualisation.labels.label') }),
    ).toBeInTheDocument();
    for (const kind of ['agents', 'roles', 'furniture', 'rooms'] as const) {
      expect(
        screen.getByRole('checkbox', {
          name: t(`visualisation.labels.${kind}`),
        }),
      ).not.toBeChecked();
    }
  });

  it('reports the kinds switched on', async () => {
    const onChange = vi.fn();
    render(<LabelTogglesControl value={['agents']} onChange={onChange} />);

    await userEvent.click(
      screen.getByRole('checkbox', { name: t('visualisation.labels.rooms') }),
    );

    expect(onChange).toHaveBeenCalledWith(['agents', 'rooms']);
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <LabelTogglesControl value={['roles']} onChange={vi.fn()} />,
    );
    await expectNoA11yViolations(container);
  });
});
