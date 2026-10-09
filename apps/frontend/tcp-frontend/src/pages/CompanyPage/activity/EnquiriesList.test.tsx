import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installFetchMock,
  respondByRoute,
} from '../../../test-support/fetch-mock';
import { EnquiriesList } from './EnquiriesList';

const COMPANY_ID = 'company-1';

const conversation = (id: string, question: string) => ({
  id,
  slug: id,
  companyId: COMPANY_ID,
  roleName: 'Sales',
  roleId: 'role-1',
  agentId: 'agent-1',
  question,
  context: null,
  status: 'awaiting_user',
  routedToIdentifiers: [],
  createdAt: '2026-08-10T09:00:00.000Z',
});

const renderEnquiries = (path: string) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[path]}>
        <EnquiriesList companyId={COMPANY_ID} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('EnquiriesList deep link from a toast', () => {
  beforeEach(() => {
    installFetchMock();
    // jsdom has no layout, so no `scrollIntoView`.
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    respondByRoute([
      [
        /\/api\/conversation\?/,
        {
          body: [
            conversation('conv-1', 'One?'),
            conversation('conv-2', 'Two?'),
          ],
        },
      ],
    ]);
  });

  it('focuses and marks the row the URL names', async () => {
    renderEnquiries('/?enquiry=conv-2');

    const target = (await screen.findByText('Two?')).closest('li');
    await vi.waitFor(() => {
      expect(target).toHaveFocus();
    });
    expect(target).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText('One?').closest('li')).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('does nothing for an id the list does not hold', async () => {
    renderEnquiries('/?enquiry=gone');

    await screen.findByText('One?');
    expect(document.body).toHaveFocus();
    expect(document.querySelector('[aria-current]')).toBeNull();
  });
});
