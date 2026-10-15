import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WireEvent } from '@tcp/shared/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECORD_CHANGE_WINDOW_MS } from '../../../../api/record-changes';
import { applyEvent } from '../../../../events/cache';
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

const renderTray = (
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) =>
  render(
    <QueryClientProvider client={client}>
      <aside aria-label="Tray test wrapper">
        <RecordsDetails companyId="company-1" headingId="records-heading" />
      </aside>
    </QueryClientProvider>,
  );

/** A `record` signal as the company stream sends it (001.05). */
const recordEvent = (companyId: string, table: string): WireEvent => ({
  type: 'audit',
  event: {
    timestamp: '2026-10-15T10:00:00.000Z',
    companyId,
    role: 'agent',
    agentId: null,
    assignmentId: null,
    taskId: null,
    eventType: 'state_change',
    payload: { entity: 'record', action: 'update', table },
  },
});

/** Hears a record change, and lets its gathering window close. */
const hear = async (queryClient: QueryClient, event: WireEvent) => {
  act(() => applyEvent(queryClient, event));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(RECORD_CHANGE_WINDOW_MS);
  });
};

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

  describe('when a table changes elsewhere (001.05)', () => {
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
    afterEach(() => vi.useRealTimers());

    it('keeps the counts current', async () => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      renderTray(client);
      const table = await screen.findByRole('table', {
        name: t('records.tray.heading'),
      });

      respond([
        { name: 'orders', purpose: '', records: 4, updatedAt: '' },
        { name: 'stock', purpose: '', records: 0, updatedAt: '' },
      ]);
      await hear(client, recordEvent('company-1', 'orders'));

      const [orders] = within(table).getAllByRole('row').slice(1);
      await waitFor(() =>
        expect(within(orders).getByRole('cell', { name: '4' })).toBeVisible(),
      );
    });
  });
});
