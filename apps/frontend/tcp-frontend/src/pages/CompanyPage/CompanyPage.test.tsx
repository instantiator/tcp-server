import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { t } from '../../strings';
import { CompanyPage } from './CompanyPage';

describe('CompanyPage', () => {
  it('names itself in the heading and the document title', () => {
    render(
      <MemoryRouter initialEntries={['/company/acme']}>
        <Routes>
          <Route path="/company/:companyId" element={<CompanyPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      screen.getByRole('heading', { name: t('page.company.title') }),
    ).toBeInTheDocument();

    // Catches a page that forgets `useDocumentTitle` and therefore announces
    // the previous page's name on arrival.
    expect(document.title).toBe(t('page.company.title'));
  });
});
