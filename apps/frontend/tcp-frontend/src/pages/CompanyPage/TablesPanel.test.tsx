import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordTableRows } from '../../api/dtos';
import { t, tCount } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import {
  installFetchMock,
  requestedUrls,
  respondByRoute,
} from '../../test-support/fetch-mock';
import { TablesPanel } from './TablesPanel';

vi.mock('../../components/RecordSheet/announceRecords', () => ({
  RECORDS_CHANNEL: 'records',
  announceRecords: vi.fn(),
}));

const BASE = '/api/company/c1/records';

const ORDERS: RecordTableRows = {
  definition: {
    id: 'd1',
    name: 'orders',
    purpose: 'Orders',
    primaryKey: ['order_id'],
    uniqueKeys: [],
    schema: { properties: { order_id: { type: 'string' } } },
  },
  rows: [],
  total: 0,
  truncated: false,
};

/** The panel with its selection held in state, as the tab holds it in the URL. */
const Harness = ({ initial }: { readonly initial: string | null }) => {
  const [selected, setSelected] = useState(initial);
  return (
    <TablesPanel
      companyId="c1"
      companySlug="acme"
      selected={selected}
      onSelect={setSelected}
    />
  );
};

const renderPanel = (initial: string | null = null) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <main>
        <Harness initial={initial} />
      </main>
    </QueryClientProvider>,
  );

describe('TablesPanel', () => {
  beforeEach(() => {
    installFetchMock();
    respondByRoute([
      [new RegExp(`${BASE}/tables/orders$`), { body: ORDERS }],
      [
        new RegExp(`${BASE}/tables$`),
        {
          body: [
            { name: 'orders', purpose: '', records: 1, updatedAt: '' },
            { name: 'stock', purpose: '', records: 12, updatedAt: '' },
          ],
        },
      ],
    ]);
  });

  it('lists each table with its count, and asks for a choice', async () => {
    renderPanel();
    const list = await screen.findByRole('listbox', {
      name: t('tables.list.label'),
    });
    const options = within(list).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      `orders${tCount('records.count', 1)}`,
      `stock${tCount('records.count', 12)}`,
    ]);
    expect(screen.getByText(t('tables.choose'))).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: t('records.downloadAll') }),
    ).toBeEnabled();
    await expectNoA11yViolations(document.body);
  });

  it('opens the chosen table, leaving focus on the list', async () => {
    const user = userEvent.setup();
    renderPanel();
    const option = await screen.findByRole('option', { name: /^orders/ });
    await user.click(option);
    expect(
      await screen.findByRole('heading', { level: 2, name: /^orders/ }),
    ).toBeInTheDocument();
    expect(option).toHaveFocus();
    expect(requestedUrls().some((u) => u.endsWith('/tables/orders'))).toBe(
      true,
    );
  });

  it('opens the table named on arrival', async () => {
    renderPanel('orders');
    expect(
      await screen.findByRole('heading', { level: 2, name: /^orders/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^orders/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('says there are no tables yet, and offers no download', async () => {
    respondByRoute([[new RegExp(`${BASE}/tables$`), { body: [] }]]);
    renderPanel();
    expect(await screen.findByText(t('tables.empty'))).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: t('records.downloadAll') }),
    ).toBeDisabled();
  });
});
