import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import { Breadcrumbs, type Crumb } from './Breadcrumbs';

const TRAIL: readonly Crumb[] = [
  { label: 'Companies', to: '/companies' },
  { label: 'Acme' },
];

describe('Breadcrumbs', () => {
  it('names the trail and marks the current page', () => {
    render(
      <MemoryRouter>
        <Breadcrumbs items={TRAIL} />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole('navigation', { name: t('breadcrumbs.label') }),
    ).toBeInTheDocument();

    const current = screen.getByText('Acme');
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(current.tagName).not.toBe('A');
  });

  it('navigates back up the trail', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/company/acme']}>
        <Routes>
          <Route path="/company/acme" element={<Breadcrumbs items={TRAIL} />} />
          <Route path="/companies" element={<p>Companies destination</p>} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('link', { name: 'Companies' }));

    expect(screen.getByText('Companies destination')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <MemoryRouter>
        <Breadcrumbs items={TRAIL} />
      </MemoryRouter>,
    );

    await expectNoA11yViolations(container);
  });
});
