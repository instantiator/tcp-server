import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { t } from '../../strings';
import { NotFoundPage } from './NotFoundPage';

describe('NotFoundPage', () => {
  it('names itself in the heading and the document title', () => {
    render(
      <MemoryRouter>
        <NotFoundPage />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole('heading', { name: t('page.notFound.title') }),
    ).toBeInTheDocument();

    // Catches a page that forgets `useDocumentTitle` and therefore announces
    // the previous page's name on arrival.
    expect(document.title).toBe(t('page.notFound.title'));
  });
});
