import { render, screen, within } from '@testing-library/react';
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

  it('renders a crumb bar inside its own li, and none when omitted', () => {
    render(
      <MemoryRouter>
        <Breadcrumbs
          items={[
            {
              label: 'Companies',
              to: '/companies',
              bar: <p>Companies bar</p>,
            },
            { label: 'Acme' },
          ]}
        />
      </MemoryRouter>,
    );

    const companiesItem = screen.getByText('Companies').closest('li');
    if (companiesItem === null) throw new Error('companies li not found');
    expect(
      within(companiesItem).getByText('Companies bar'),
    ).toBeInTheDocument();

    const acmeItem = screen.getByText('Acme').closest('li');
    if (acmeItem === null) throw new Error('acme li not found');
    expect(within(acmeItem).queryByText('Companies bar')).toBeNull();
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
