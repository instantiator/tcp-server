import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../../../strings';
import { expectNoA11yViolations } from '../../../../test-support/axe';
import {
  installFetchMock,
  respondByRoute,
} from '../../../../test-support/fetch-mock';
import { RecordsDetails } from './RecordsDetails';

vi.mock('../../../../components/RecordSheet/announceRecords', () => ({
  RECORDS_CHANNEL: 'records',
  announceRecords: vi.fn(),
}));

const COMPANY_ROUTE = /\/api\/company\/company-1(\?|$)/;
const TABLES_ROUTE = /\/api\/company\/company-1\/records\/tables$/;
const ORDERS_ROUTE = /\/api\/company\/company-1\/records\/tables\/orders$/;

const company = {
  id: 'company-1',
  slug: 'acme',
  name: 'Acme',
  description: '',
  mcpServerList: [],
  nextTaskShortcodeIndex: 1,
};

const respond = (tables: unknown[]) =>
  respondByRoute([
    [
      ORDERS_ROUTE,
      {
        body: {
          definition: {
            id: 'd1',
            name: 'orders',
            purpose: '',
            primaryKey: ['order_id'],
            uniqueKeys: [],
            retention: null,
            schema: { properties: { order_id: { type: 'string' } } },
          },
          rows: [],
          total: 0,
          truncated: false,
        },
      },
    ],
    [TABLES_ROUTE, { body: tables }],
    [COMPANY_ROUTE, { body: company }],
  ]);

const renderTray = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <aside aria-label="Tray test wrapper">
        <RecordsDetails companyId="company-1" headingId="records-heading" />
      </aside>
    </QueryClientProvider>,
  );

describe('RecordsDetails', () => {
  beforeEach(() => {
    installFetchMock();
    respond([
      { name: 'orders', purpose: '', records: 3, updatedAt: '' },
      { name: 'stock', purpose: '', records: 0, updatedAt: '' },
    ]);
  });

  it('lists each table with its count, a download and a More menu', async () => {
    renderTray();
    const table = await screen.findByRole('table', {
      name: t('records.tray.heading'),
    });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole('rowheader')).toHaveTextContent('orders');
    expect(
      within(rows[0]).getByRole('cell', { name: '3' }),
    ).toBeInTheDocument();
    expect(
      within(rows[0]).getByRole('button', {
        name: t('records.download', { table: 'orders' }),
      }),
    ).toBeInTheDocument();
    expect(
      within(rows[0]).getByRole('button', {
        name: t('records.more', { table: 'orders' }),
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: t('records.downloadAll') }),
    ).toBeEnabled();
    await expectNoA11yViolations(document.body);
  });

  it("opens a table's sheet in a dialog named after it", async () => {
    const user = userEvent.setup();
    renderTray();
    await user.click(await screen.findByRole('button', { name: 'orders' }));
    const dialog = await screen.findByRole('dialog', { name: 'orders' });
    expect(
      await within(dialog).findByRole('grid', {
        name: t('records.sheet.label', { table: 'orders' }),
      }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(document.body);
  });

  it('says there are no tables yet', async () => {
    respond([]);
    renderTray();
    expect(await screen.findByText(t('tables.empty'))).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: t('records.downloadAll') }),
    ).toBeDisabled();
  });
});
