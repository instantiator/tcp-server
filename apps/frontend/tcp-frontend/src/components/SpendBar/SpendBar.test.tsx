import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../test-support/axe';
import { SpendBar } from './SpendBar';

const DETAILS = [
  'anthropic: 65% of 1,000,000 tokens per 5h',
  'openai: 10% of 500,000 tokens per day',
];

describe('SpendBar', () => {
  it('renders a meter named by aria-valuetext', () => {
    render(
      <SpendBar
        percent={65}
        tone="warning"
        valueText="65% of 1,000,000 tokens per 5h"
        details={DETAILS}
      />,
    );

    const meter = screen.getByRole('meter');
    expect(meter).toHaveAttribute(
      'aria-valuetext',
      '65% of 1,000,000 tokens per 5h',
    );
  });

  it('clamps aria-valuenow at 100 for a reached cap over 100%', () => {
    render(
      <SpendBar
        percent={130}
        tone="holding"
        valueText="130% of 1,000,000 tokens per 5h"
        details={DETAILS}
      />,
    );

    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '100');
  });

  it('shows the tooltip details on keyboard focus (WCAG 1.4.13)', async () => {
    const user = userEvent.setup();
    render(
      <SpendBar
        percent={65}
        tone="warning"
        valueText="65% of 1,000,000 tokens per 5h"
        details={DETAILS}
      />,
    );

    expect(screen.queryByRole('tooltip')).toBeNull();

    await user.tab();

    const tooltip = await screen.findByRole('tooltip');
    for (const line of DETAILS) {
      expect(tooltip).toHaveTextContent(line);
    }
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <SpendBar
        percent={65}
        tone="warning"
        valueText="65% of 1,000,000 tokens per 5h"
        details={DETAILS}
      />,
    );

    await expectNoA11yViolations(container);
  });
});
