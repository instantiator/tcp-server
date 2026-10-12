import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordTableRows, TimedRecord } from '../../api/dtos';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import {
  fetchMock,
  installFetchMock,
  respondByRoute,
} from '../../test-support/fetch-mock';
import { announceRecords } from './announceRecords';
import { TableView } from './TableView';

vi.mock('./announceRecords', () => ({
  RECORDS_CHANNEL: 'records',
  announceRecords: vi.fn(),
}));

const BASE = '/api/company/c1/records';

const row = (
  id: string,
  data: Record<string, unknown>,
  version = 1,
): TimedRecord => ({
  id,
  data,
  version,
  createdAt: '2026-10-11T09:00:00.000Z',
  updatedAt: '2026-10-11T10:00:00.000Z',
});

const TABLE: RecordTableRows = {
  definition: {
    id: 'd1',
    name: 'orders',
    purpose: 'Orders',
    primaryKey: ['order_id'],
    uniqueKeys: [],
    schema: {
      properties: {
        qty: { type: 'integer' },
        order_id: { type: 'string' },
        paid: { type: 'boolean' },
      },
      required: ['order_id', 'qty'],
    },
    retention: null,
  },
  rows: [
    row('r2', { order_id: 'A2', qty: 5, paid: true }, 3),
    row('r1', { order_id: 'A1', qty: 2 }),
  ],
  total: 2,
  truncated: false,
};

const renderView = (children?: ReactNode) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      {children ?? (
        <TableView
          companyId="c1"
          companySlug="acme"
          table="orders"
          titleLevel={2}
        />
      )}
    </QueryClientProvider>,
  );
};

/** The method and parsed JSON body of each request whose URL matches `path`. */
const requestsTo = async (path: RegExp) => {
  const found: { method: string; body: unknown }[] = [];
  for (const [input] of fetchMock.mock.calls) {
    if (!(input instanceof Request) || !path.test(input.url)) continue;
    const text = await input.clone().text();
    found.push({
      method: input.method,
      body: text === '' ? null : (JSON.parse(text) as unknown),
    });
  }
  return found;
};

describe('TableView', () => {
  beforeEach(() => {
    installFetchMock();
    vi.mocked(announceRecords).mockReset();
    respondByRoute([[new RegExp(`${BASE}/tables/orders$`), { body: TABLE }]]);
  });

  it('shows the key first, then the fields alphabetically, then Updated, rows as loaded', async () => {
    renderView();
    const grid = await screen.findByRole('grid', {
      name: t('records.sheet.label', { table: 'orders' }),
    });
    const headers = within(grid).getAllByRole('columnheader');
    // AG Grid pads header text and adds the sort position after the name.
    expect(headers.map((h) => h.textContent.trim().split(/\s+/)[0])).toEqual([
      'order_id',
      'paid',
      'qty',
      t('records.column.updated'),
    ]);
    expect(headers[0]).toHaveTextContent(
      t('records.column.key', { field: 'order_id' }),
    );
    expect(headers[3]).toHaveAttribute('aria-sort', 'descending');
    const firstCells = within(grid)
      .getAllByRole('row')
      .slice(1)
      .map((r) => within(r).getAllByRole('gridcell')[0].textContent);
    expect(firstCells).toEqual(['A2', 'A1']);
    await expectNoA11yViolations(document.body);
  });

  /** The cell in `column` of the row whose key is `key`, once the grid has drawn it. */
  const cell = (key: string, column: number) =>
    waitFor(() => {
      const target = within(screen.getByRole('grid'))
        .getAllByRole('row')
        .find(
          (r) => within(r).queryAllByRole('gridcell')[0]?.textContent === key,
        );
      if (target === undefined) throw new Error(`no row ${key} yet`);
      return within(target).getAllByRole('gridcell')[column];
    });

  /** The bodies sent to `path` with `method`. */
  const bodiesTo = async (path: RegExp, method: string) =>
    (await requestsTo(path))
      .filter((r) => r.method === method)
      .map((r) => r.body);

  it('saves an edit against the row version, marks it, and undoes it', async () => {
    const user = userEvent.setup();
    respondByRoute([
      [/\/rows\/r1$/, { body: row('r1', { order_id: 'A1', qty: 7 }, 2) }],
      [new RegExp(`${BASE}/tables/orders$`), { body: TABLE }],
    ]);
    renderView();

    await user.click(await cell('A1', 2));
    const editor = await within(await cell('A1', 2)).findByRole('spinbutton');
    await user.clear(editor);
    await user.type(editor, '7{Enter}');

    await waitFor(async () =>
      expect(await bodiesTo(/\/rows\/r1$/, 'PATCH')).toEqual([
        { changes: { qty: 7 }, version: 1 },
      ]),
    );
    expect(announceRecords).toHaveBeenCalledWith('records.announce.saved', {
      field: 'qty',
      row: 'A1',
    });
    await waitFor(async () =>
      expect(await cell('A1', 2)).toHaveTextContent(`7${t('records.changed')}`),
    );

    const undoLabel = t('records.undo', {
      change: t('records.change.edit', { field: 'qty', row: 'A1' }),
    });
    await user.click(screen.getByRole('button', { name: undoLabel }));
    await waitFor(async () =>
      expect(await bodiesTo(/\/rows\/r1$/, 'PATCH')).toHaveLength(2),
    );
    expect((await bodiesTo(/\/rows\/r1$/, 'PATCH'))[1]).toEqual({
      changes: { qty: 2 },
      version: 2,
    });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: t('records.undo.none') }),
      ).toBeDisabled(),
    );
  });

  it('reloads the table and says so when an edit meets a newer version', async () => {
    const user = userEvent.setup();
    respondByRoute([
      [
        /\/rows\/r1$/,
        { status: 409, body: { message: 'changed', code: 'stale' } },
      ],
      [new RegExp(`${BASE}/tables/orders$`), { body: TABLE }],
    ]);
    renderView();
    await user.click(await cell('A1', 2));
    const editor = await within(await cell('A1', 2)).findByRole('spinbutton');
    await user.type(editor, '9{Enter}');

    await waitFor(() =>
      expect(announceRecords).toHaveBeenCalledWith('records.announce.stale'),
    );
    const reads = (await requestsTo(new RegExp(`${BASE}/tables/orders$`)))
      .length;
    expect(reads).toBeGreaterThan(1);
    expect(
      screen.getByRole('button', { name: t('records.undo.none') }),
    ).toBeDisabled();
  });

  it('deletes the focused row after asking, and undoing brings it back', async () => {
    const user = userEvent.setup();
    respondByRoute([
      [/\/rows\/r1\?version=1$/, { status: 204, body: undefined }],
      [/\/rows$/, { status: 201, body: row('r9', { order_id: 'A1', qty: 2 }) }],
      [new RegExp(`${BASE}/tables/orders$`), { body: TABLE }],
    ]);
    renderView();

    expect(
      screen.getByRole('button', { name: t('records.deleteRow.none') }),
    ).toBeDisabled();
    await user.click(await cell('A1', 1));
    await user.keyboard('{Escape}');
    await user.click(
      screen.getByRole('button', {
        name: t('records.deleteRow', { row: 'A1' }),
      }),
    );
    const confirm = await screen.findByRole('alertdialog', {
      name: t('records.deleteRow.heading', { row: 'A1' }),
    });
    await user.click(
      within(confirm).getByRole('button', {
        name: t('records.deleteRow.confirm'),
      }),
    );
    await waitFor(() =>
      expect(announceRecords).toHaveBeenCalledWith('records.announce.deleted', {
        row: 'A1',
      }),
    );

    await user.click(
      screen.getByRole('button', {
        name: t('records.undo', {
          change: t('records.change.delete', { row: 'A1' }),
        }),
      }),
    );
    await waitFor(async () =>
      expect(await bodiesTo(/\/rows$/, 'POST')).toEqual([
        { data: { order_id: 'A1', qty: 2 } },
      ]),
    );
  });

  it('checks a new row field by field, and reports a key already in use', async () => {
    const user = userEvent.setup();
    respondByRoute([
      [
        /\/rows$/,
        {
          status: 409,
          body: { message: 'taken', code: 'conflict', recordId: 'r1' },
        },
      ],
      [new RegExp(`${BASE}/tables/orders$`), { body: TABLE }],
    ]);
    renderView();
    await screen.findByRole('grid');
    await user.click(
      screen.getByRole('button', {
        name: t('records.addRow', { table: 'orders' }),
      }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: t('records.addRow.heading', { table: 'orders' }),
    });
    await user.type(within(dialog).getByLabelText(/qty/), 'lots');
    await user.click(
      within(dialog).getByRole('button', { name: t('records.addRow.submit') }),
    );
    expect(
      within(dialog).getByLabelText(/order_id/),
    ).toHaveAccessibleDescription(t('records.addRow.required'));
    expect(within(dialog).getByLabelText(/qty/)).toHaveAccessibleDescription(
      t('records.addRow.integer'),
    );
    expect(within(dialog).getByLabelText(/order_id/)).toHaveFocus();
    await expectNoA11yViolations(document.body);

    await user.type(within(dialog).getByLabelText(/order_id/), 'A1');
    await user.clear(within(dialog).getByLabelText(/qty/));
    await user.type(within(dialog).getByLabelText(/qty/), '3');
    await user.click(
      within(dialog).getByRole('button', { name: t('records.addRow.submit') }),
    );
    await waitFor(() =>
      expect(
        within(dialog).getByLabelText(/order_id/),
      ).toHaveAccessibleDescription(t('records.addRow.clash')),
    );
  });

  it('lists the CSV rows that stop an append, by spreadsheet row', async () => {
    const user = userEvent.setup();
    respondByRoute([
      [
        /\/csv$/,
        {
          status: 400,
          body: {
            message: 'no',
            errors: [{ row: 3, message: 'qty must be a whole number' }],
          },
        },
      ],
      [new RegExp(`${BASE}/tables/orders$`), { body: TABLE }],
    ]);
    renderView();
    await screen.findByRole('grid');
    await user.click(
      screen.getByRole('button', {
        name: t('records.more', { table: 'orders' }),
      }),
    );
    await user.click(
      screen.getByRole('menuitem', { name: t('records.action.append') }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: t('records.append.heading', { table: 'orders' }),
    });
    await user.upload(
      within(dialog).getByLabelText(t('records.append.file')),
      new File(['order_id,qty\nA,x\n'], 'o.csv', { type: 'text/csv' }),
    );
    await user.click(
      within(dialog).getByRole('button', { name: t('records.append.submit') }),
    );
    expect(
      await within(dialog).findByText(
        t('records.append.errorRow', {
          row: 3,
          message: 'qty must be a whole number',
        }),
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByLabelText(t('records.append.file')),
    ).toHaveAccessibleDescription(expect.stringContaining('Row 3'));
  });

  it('asks before clearing, with the count, offering a download first', async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByRole('grid');
    await user.click(
      screen.getByRole('button', {
        name: t('records.more', { table: 'orders' }),
      }),
    );
    await user.click(
      screen.getByRole('menuitem', { name: t('records.action.clear') }),
    );
    const confirm = await screen.findByRole('alertdialog', {
      name: t('records.clear.heading', { table: 'orders' }),
    });
    expect(confirm).toHaveTextContent(
      t('records.clear.message.other', { count: 2 }),
    );
    expect(
      within(confirm).getByRole('button', { name: t('records.downloadFirst') }),
    ).toBeInTheDocument();
    // Focus starts on the safe answer.
    expect(
      within(confirm).getByRole('button', { name: t('confirm.no') }),
    ).toHaveFocus();
  });

  it('undoes with Ctrl+Z on a cell, but not while the cell is being edited', async () => {
    const user = userEvent.setup();
    respondByRoute([
      [/\/rows\/r1$/, { body: row('r1', { order_id: 'A1', qty: 7 }, 2) }],
      [new RegExp(`${BASE}/tables/orders$`), { body: TABLE }],
    ]);
    renderView();
    await user.click(await cell('A1', 2));
    const editor = await within(await cell('A1', 2)).findByRole('spinbutton');
    await user.clear(editor);
    await user.type(editor, '7{Enter}');
    await waitFor(async () =>
      expect(await bodiesTo(/\/rows\/r1$/, 'PATCH')).toHaveLength(1),
    );

    // Editing again: Ctrl+Z belongs to the editor.
    await user.keyboard('{Enter}{Control>}z{/Control}{Escape}');
    expect(await bodiesTo(/\/rows\/r1$/, 'PATCH')).toHaveLength(1);

    await user.keyboard('{Control>}z{/Control}');
    await waitFor(async () =>
      expect(await bodiesTo(/\/rows\/r1$/, 'PATCH')).toHaveLength(2),
    );
  });
});
