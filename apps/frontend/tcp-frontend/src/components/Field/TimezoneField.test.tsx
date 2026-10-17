import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../test-support/axe';
import { TimezoneField } from './TimezoneField';
import { isKnownTimeZone } from './timeZones';

/** Holds the value, as a host form would. */
const Host = ({ initial = '' }: { initial?: string }) => {
  const [value, setValue] = useState(initial);
  return (
    <>
      <TimezoneField label="Time zone" value={value} onChange={setValue} />
      <output>{value}</output>
    </>
  );
};

describe('TimezoneField', () => {
  it('filters the zones by what is typed, and takes the one picked', async () => {
    const user = userEvent.setup();
    render(<Host />);

    await user.type(
      screen.getByRole('combobox', { name: 'Time zone' }),
      'lond',
    );
    await user.click(
      await screen.findByRole('option', { name: 'Europe/London' }),
    );

    expect(screen.getByRole('status')).toHaveTextContent('Europe/London');
  });

  it('can be cleared', async () => {
    const user = userEvent.setup();
    render(<Host initial="Europe/London" />);

    await user.clear(screen.getByRole('combobox', { name: 'Time zone' }));

    // The open list hides the rest of the page from assistive technology.
    expect(screen.getByRole('status', { hidden: true })).toBeEmptyDOMElement();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<Host initial="Europe/London" />);
    await expectNoA11yViolations(container);
  });
});

describe('isKnownTimeZone', () => {
  it.each([
    ['', true],
    ['Europe/London', true],
    ['UTC', true],
    ['europe/london', false],
    ['Mars/Olympus', false],
  ])('%j → %s', (value, known) => {
    expect(isKnownTimeZone(value)).toBe(known);
  });
});
