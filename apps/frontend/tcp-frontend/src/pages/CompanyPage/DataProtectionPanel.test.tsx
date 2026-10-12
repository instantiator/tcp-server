import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DoNotStoreEntry,
  RecordSearchResult,
  RecordTableDefinition,
  TimedRecord,
} from '../../api/dtos';
import { t, tCount } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import {
  fetchMock,
  installFetchMock,
  requestedUrls,
  respondByRoute,
} from '../../test-support/fetch-mock';
import { DataProtectionPanel } from './DataProtectionPanel';

vi.mock('../../components/RecordSheet/announceRecords', () => ({
  RECORDS_CHANNEL: 'records',
  announceRecords: vi.fn(),
}));

const BASE = '/api/company/c1/records';
const NOW = '2026-10-12T09:00:00.000Z';

const definition = (name: string, fields: string[]): RecordTableDefinition => ({
  id: name,
  name,
  purpose: '',
  primaryKey: [fields[0]],
  uniqueKeys: [],
  retention: null,
  schema: {
    properties: Object.fromEntries(
      fields.map((f) => [f, { type: 'string' as const }]),
    ),
    required: [fields[0]],
  },
});

const row = (id: string, data: Record<string, unknown>): TimedRecord => ({
  id,
  data,
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
});

const FOUND: RecordSearchResult = {
  groups: [
    {
      definition: definition('contacts', ['email']),
      rows: [row('c1', { email: 'ann@example.com' })],
    },
    {
      definition: definition('orders', ['order_id', 'customer']),
      rows: [
        row('o1', { order_id: 'A1', customer: 'Ann Lee' }),
        row('o2', { order_id: 'A2', customer: 'Ann Lee' }),
      ],
    },
  ],
  truncated: false,
};

const ENTRY: DoNotStoreEntry = {
  id: 'e1',
  value: 'Bob Ray',
  note: null,
  addedByRole: 'agent',
  addedById: null,
  createdAt: NOW,
  updatedAt: NOW,
};

/** The method and JSON body of each request whose URL matches `path`. */
const bodiesTo = async (path: RegExp, method: string) => {
  const found: unknown[] = [];
  for (const [input] of fetchMock.mock.calls) {
    if (
      !(input instanceof Request) ||
      input.method !== method ||
      !path.test(input.url)
    )
      continue;
    const text = await input.clone().text();
    found.push(text === '' ? null : (JSON.parse(text) as unknown));
  }
  return found;
};

const renderPanel = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <DataProtectionPanel companyId="c1" companySlug="acme" />
    </QueryClientProvider>,
  );

/** The grid row, in the grid named `grid`, whose first record cell reads `key`. */
const rowIn = (grid: string, key: string) =>
  waitFor(() => {
    const found = within(screen.getByRole('grid', { name: grid }))
      .getAllByRole('row')
      .find((r) =>
        within(r)
          .queryAllByRole('gridcell')
          .some((c) => c.textContent === key),
      );
    if (found === undefined) throw new Error(`no row ${key} yet`);
    return found;
  });

describe('DataProtectionPanel', () => {
  beforeEach(() => {
    installFetchMock();
    respondByRoute([
      [/\/search$/, { body: FOUND }],
      [/\/do-not-store$/, { body: [ENTRY] }],
      [/\/do-not-store\/e1$/, { status: 204, body: undefined }],
      [/\/rows\/delete$/, { body: { removed: 1 } }],
      [/\/export$/, { body: 'csv' }],
    ]);
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
      () => undefined,
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("points to the ICO's own guidance, and says what the page doesn't reach", async () => {
    renderPanel();
    const link = screen.getByRole('link', {
      name: t('dataProtection.duties.link'),
    });
    expect(link).toHaveAttribute(
      'href',
      'https://ico.org.uk/for-organisations/data-protection-fee/',
    );
    expect(screen.getByText(t('dataProtection.scope'))).toBeVisible();
    await screen.findByRole('grid', { name: t('dataProtection.list.sheet') });
    await expectNoA11yViolations(document.body);
  });

  it('refuses a search too short to mean anything', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(
      screen.getByRole('textbox', { name: t('dataProtection.search.label') }),
      'a',
    );
    await user.click(
      screen.getByRole('button', { name: t('dataProtection.search.submit') }),
    );
    expect(screen.getByText(t('dataProtection.search.tooShort'))).toBeVisible();
    expect(requestedUrls().some((u) => u.endsWith('/search'))).toBe(false);
  });

  it('finds a person in every table, one sheet each, and downloads every match', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(
      screen.getByRole('textbox', { name: t('dataProtection.search.label') }),
      'Ann',
    );
    await user.click(
      screen.getByRole('button', { name: t('dataProtection.search.submit') }),
    );

    expect(
      await screen.findByRole('grid', {
        name: t('dataProtection.search.sheet', { table: 'contacts' }),
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('grid', {
        name: t('dataProtection.search.sheet', { table: 'orders' }),
      }),
    ).toBeInTheDocument();
    expect(await bodiesTo(/\/search$/, 'POST')).toEqual([{ q: 'Ann' }]);

    await user.click(
      screen.getByRole('button', {
        name: t('dataProtection.search.downloadAll'),
      }),
    );
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([input]) =>
          input instanceof URL && input.pathname === `${BASE}/export`,
      );
      const body = call?.[1]?.body;
      expect(typeof body === 'string' ? JSON.parse(body) : body).toEqual({
        tables: { contacts: ['c1'], orders: ['o1', 'o2'] },
      });
    });
  });

  it('deletes rows ticked in different tables, one request per table, after asking', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(
      screen.getByRole('textbox', { name: t('dataProtection.search.label') }),
      'Ann',
    );
    await user.click(
      screen.getByRole('button', { name: t('dataProtection.search.submit') }),
    );
    const contacts = t('dataProtection.search.sheet', { table: 'contacts' });
    const orders = t('dataProtection.search.sheet', { table: 'orders' });
    await user.click(
      within(await rowIn(contacts, 'ann@example.com')).getByRole('checkbox'),
    );
    await user.click(within(await rowIn(orders, 'A2')).getByRole('checkbox'));

    await user.click(
      screen.getByRole('button', {
        name: tCount('records.selected.delete', 2),
      }),
    );
    const confirm = await screen.findByRole('alertdialog', {
      name: tCount('records.deleteRows.heading', 2),
    });
    await user.click(
      within(confirm).getByRole('button', {
        name: t('records.deleteRows.confirm'),
      }),
    );

    await waitFor(async () =>
      expect(await bodiesTo(/\/rows\/delete$/, 'POST')).toHaveLength(2),
    );
    expect(requestedUrls().filter((u) => u.endsWith('/rows/delete'))).toEqual([
      expect.stringContaining('/tables/contacts/'),
      expect.stringContaining('/tables/orders/'),
    ]);
    expect(await bodiesTo(/\/rows\/delete$/, 'POST')).toEqual([
      { rows: [{ id: 'c1', version: 1 }] },
      { rows: [{ id: 'o2', version: 1 }] },
    ]);
  });

  describe('the do-not-store list', () => {
    it('adds an entry, then offers to search the records for it', async () => {
      const user = userEvent.setup();
      // The list's route answers a GET with the list and a POST with the entry.
      fetchMock.mockImplementation((input) => {
        const request = input instanceof Request ? input : null;
        const body = request?.url.endsWith('/search')
          ? { groups: [], truncated: false }
          : request?.method === 'POST'
            ? { ...ENTRY, value: 'Ann Lee' }
            : [];
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: request?.method === 'POST' ? 201 : 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      });
      renderPanel();
      await user.type(
        screen.getByRole('textbox', { name: t('dataProtection.list.value') }),
        'Ann Lee',
      );
      await user.click(
        screen.getByRole('button', { name: t('dataProtection.list.add') }),
      );
      await waitFor(async () =>
        expect(await bodiesTo(/\/do-not-store$/, 'POST')).toEqual([
          { value: 'Ann Lee' },
        ]),
      );

      await user.click(
        await screen.findByRole('button', {
          name: t('dataProtection.list.searchFor', { value: 'Ann Lee' }),
        }),
      );
      await waitFor(async () =>
        expect(await bodiesTo(/\/search$/, 'POST')).toEqual([{ q: 'Ann Lee' }]),
      );
    });

    it('shows who added an entry, and removes ticked entries after asking', async () => {
      const user = userEvent.setup();
      renderPanel();
      const list = t('dataProtection.list.sheet');
      const entry = await rowIn(list, 'Bob Ray');
      expect(entry).toHaveTextContent(t('dataProtection.list.byAgent'));

      await user.click(within(entry).getByRole('checkbox'));
      await user.click(
        screen.getByRole('button', {
          name: tCount('dataProtection.list.remove', 1),
        }),
      );
      const confirm = await screen.findByRole('alertdialog', {
        name: t('dataProtection.list.remove.heading'),
      });
      await user.click(
        within(confirm).getByRole('button', {
          name: t('dataProtection.list.remove.confirm'),
        }),
      );

      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([input]) =>
              input instanceof Request &&
              input.method === 'DELETE' &&
              input.url.endsWith(`${BASE}/do-not-store/e1`),
          ),
        ).toBe(true),
      );
    });
  });
});
