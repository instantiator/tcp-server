import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { WireEvent } from '@tcp/shared/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordTableRows } from '../../api/dtos';
import { RECORD_CHANGE_WINDOW_MS } from '../../api/record-changes';
import { applyEvent } from '../../events/cache';
import { t, tCount } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import {
  installFetchMock,
  requestedUrls,
  respondByRoute,
} from '../../test-support/fetch-mock';
import { DataPanel, type DataSelection } from './DataPanel';

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
    retention: null,
  },
  rows: [],
  total: 0,
  truncated: false,
};

/** The panel with its selection held in state, as the tab holds it in the URL. */
const Harness = ({ initial }: { readonly initial: DataSelection }) => {
  const [selected, setSelected] = useState(initial);
  return (
    <DataPanel
      companyId="c1"
      companySlug="acme"
      selected={selected}
      onSelect={setSelected}
    />
  );
};

const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** A table to open on arrival, or none. */
const tables = (table: string | null = null): DataSelection => ({
  kind: 'tables',
  table,
});

const renderPanel = (initial = tables(), client = newClient()) =>
  render(
    <QueryClientProvider client={client}>
      <main>
        <Harness initial={initial} />
      </main>
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

describe('DataPanel', () => {
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

  it('lists each table with its count under Tables, then Documents, and asks for a choice', async () => {
    renderPanel();
    const list = await screen.findByRole('listbox', {
      name: t('data.menu.label'),
    });
    await within(list).findByRole('option', { name: /^orders/ });
    expect(
      within(list).getByRole('group', { name: t('data.menu.tables') }),
    ).toBeInTheDocument();
    const options = within(list).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      `orders${tCount('records.count', 1)}`,
      `stock${tCount('records.count', 12)}`,
      t('data.menu.documents'),
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
    renderPanel(tables('orders'));
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

  it('opens Documents from the menu, leaving focus on the menu', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByRole('option', { name: /^orders/ });
    const documents = screen.getByRole('option', {
      name: t('data.menu.documents'),
    });
    await user.click(documents);
    expect(
      screen.getByRole('heading', { level: 2, name: t('documents.heading') }),
    ).toBeInTheDocument();
    expect(documents).toHaveFocus();
    expect(documents).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps a table named "documents" apart from the Documents item', async () => {
    respondByRoute([
      [
        new RegExp(`${BASE}/tables$`),
        {
          body: [{ name: 'documents', purpose: '', records: 3, updatedAt: '' }],
        },
      ],
    ]);
    renderPanel({ kind: 'documents' });
    await screen.findByRole('option', { name: 'documents' });
    expect(
      screen.getByRole('option', { name: t('data.menu.documents') }),
    ).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'documents' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  describe('when tables change elsewhere (001.05)', () => {
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
    afterEach(() => vi.useRealTimers());

    it('keeps the counts current, and lists new tables and drops deleted ones', async () => {
      const client = newClient();
      renderPanel(tables(), client);
      await screen.findByRole('option', { name: /^stock/ });

      respondByRoute([
        [
          new RegExp(`${BASE}/tables$`),
          {
            body: [
              { name: 'leads', purpose: '', records: 4, updatedAt: '' },
              { name: 'orders', purpose: '', records: 2, updatedAt: '' },
            ],
          },
        ],
      ]);
      await hear(client, recordEvent('c1', 'leads'));

      await waitFor(() =>
        expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(
          [
            `leads${tCount('records.count', 4)}`,
            `orders${tCount('records.count', 2)}`,
            t('data.menu.documents'),
          ],
        ),
      );
    });

    it('keeps a table open, saying so, when it is deleted elsewhere', async () => {
      const client = newClient();
      renderPanel(tables('orders'), client);
      await screen.findByRole('heading', { level: 2, name: /^orders/ });

      respondByRoute([
        [
          new RegExp(`${BASE}/tables/orders$`),
          { status: 404, body: { message: 'no such table' } },
        ],
        [
          new RegExp(`${BASE}/tables$`),
          {
            body: [{ name: 'stock', purpose: '', records: 12, updatedAt: '' }],
          },
        ],
      ]);
      await hear(client, recordEvent('c1', 'orders'));

      await waitFor(() =>
        expect(screen.queryByRole('option', { name: /^orders/ })).toBeNull(),
      );
      expect(
        await screen.findByRole('group', {
          name: t('records.outOfDate.label'),
        }),
      ).toHaveTextContent(t('records.outOfDate.dropped'));
      expect(
        screen.getByRole('heading', { level: 2, name: /^orders/ }),
      ).toBeInTheDocument();
    });
  });
});
