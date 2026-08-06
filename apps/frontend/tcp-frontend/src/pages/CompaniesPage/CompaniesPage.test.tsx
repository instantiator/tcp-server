import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../strings';
import { CompaniesPage } from './CompaniesPage';

describe('CompaniesPage', () => {
  it('names itself in the heading and the document title', () => {
    render(<CompaniesPage />);

    expect(
      screen.getByRole('heading', { name: t('page.companies.title') }),
    ).toBeInTheDocument();

    // Catches a page that forgets `useDocumentTitle` and therefore announces
    // the previous page's name on arrival.
    expect(document.title).toBe(t('page.companies.title'));
  });
});
