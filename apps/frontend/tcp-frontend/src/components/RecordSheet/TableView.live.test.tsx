import { virtual } from '@guidepup/virtual-screen-reader';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WireEvent } from '@tcp/shared/client';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordTableRows, TimedRecord } from '../../api/dtos';
import { RECORD_CHANGE_WINDOW_MS } from '../../api/record-changes';
import { applyEvent } from '../../events/cache';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import {
  installFetchMock,
  respondByRoute,
} from '../../test-support/fetch-mock';
import { TableView } from './TableView';

// The sheet's own actions announce through this; the notice does not.
vi.mock('./announceRecords', () => ({
  RECORDS_CHANNEL: 'records',
  announceRecords: vi.fn(),
}));

const TABLE_URL = /\/api\/company\/c1\/records\/tables\/orders$/;

/** AG Grid's checkbox column for picking rows; the record's own cells come after it. */
const SELECTION_COLUMN = 'ag-Grid-SelectionColumn';

const row = (
  id: string,
  data: Record<string, unknown>,
  version = 1,
): TimedRecord => ({
  id,
  data,
  version,
  createdAt: '2026-10-15T09:00:00.000Z',
  updatedAt: '2026-10-15T10:00:00.000Z',
});

const tableOf = (rows: TimedRecord[]): RecordTableRows => ({
  definition: {
    id: 'd1',
    name: 'orders',
    purpose: 'Orders',
    primaryKey: ['order_id'],
    uniqueKeys: [],
    schema: {
      properties: { order_id: { type: 'string' }, qty: { type: 'integer' } },
      required: ['order_id', 'qty'],
    },
    retention: null,
  },
  rows,
  total: rows.length,
  truncated: false,
});

const OPENED = tableOf([
  row('r2', { order_id: 'A2', qty: 5 }),
  row('r1', { order_id: 'A1', qty: 2 }),
]);

/** An agent changed A1 and added A3. */
const CHANGED = tableOf([
  row('r3', { order_id: 'A3', qty: 1 }),
  row('r1', { order_id: 'A1', qty: 9 }, 2),
  row('r2', { order_id: 'A2', qty: 5 }),
]);

/** A `record` signal as the company stream sends it. */
const recordEvent = (action = 'update'): WireEvent => ({
  type: 'audit',
  event: {
    timestamp: '2026-10-15T10:00:00.000Z',
    companyId: 'c1',
    role: 'agent',
    agentId: null,
    assignmentId: null,
    taskId: null,
    eventType: 'state_change',
    payload: { entity: 'record', action, table: 'orders' },
  },
});

/** Renders the sheet as the app does, in StrictMode. */
const renderView = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <TableView
          companyId="c1"
          companySlug="acme"
          table="orders"
          titleLevel={2}
        />
      </QueryClientProvider>
    </StrictMode>,
  );
  return queryClient;
};

/** The data cells of the row whose key is `key`, once the grid has drawn it. */
const cellsOf = (key: string) =>
  waitFor(() => {
    const found = within(screen.getByRole('grid'))
      .getAllByRole('row')
      .map((r) =>
        within(r)
          .queryAllByRole('gridcell')
          .filter((c) => c.getAttribute('col-id') !== SELECTION_COLUMN),
      )
      .find((cells) => cells[0]?.textContent?.startsWith(key));
    if (found === undefined) throw new Error(`no row ${key} yet`);
    return found;
  });

/** The keys of the rows in the order they are shown. */
const shownKeys = () =>
  within(screen.getByRole('grid'))
    .getAllByRole('row')
    .slice(1)
    .map(
      (r) =>
        within(r)
          .queryAllByRole('gridcell')
          .filter((c) => c.getAttribute('col-id') !== SELECTION_COLUMN)[0]
          ?.textContent,
    );

/** Hears a change elsewhere, and lets the sheet read the table again. */
const hearChange = async (
  queryClient: QueryClient,
  now: RecordTableRows | { status: number; body: unknown },
  action?: string,
) => {
  respondByRoute([[TABLE_URL, 'status' in now ? now : { body: now }]]);
  act(() => applyEvent(queryClient, recordEvent(action)));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(RECORD_CHANGE_WINDOW_MS);
  });
};

/**
 * What was said, less AG Grid's own pagination region ("Page 1 of 1"), which
 * speaks whenever the grid draws and is not this feature's to test.
 */
const spoken = async () =>
  (await virtual.spokenPhraseLog()).filter((p) => !/Page \d+ of \d+/.test(p));

const notice = () =>
  screen.findByRole('group', { name: t('records.outOfDate.label') });

describe('TableView when the table changes elsewhere (001.05)', () => {
  beforeEach(async () => {
    installFetchMock();
    respondByRoute([[TABLE_URL, { body: OPENED }]]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await virtual.start({ container: document.body });
  });

  afterEach(async () => {
    await virtual.stop();
    vi.useRealTimers();
  });

  it('says so once, keeps the rows where they are, and counts later changes silently', async () => {
    const queryClient = renderView();
    await cellsOf('A1');
    await virtual.clearSpokenPhraseLog();

    await hearChange(queryClient, CHANGED);

    expect(await notice()).toHaveTextContent(
      `${t('records.outOfDate.intro')} 1 row changed, 1 row added. ${t('records.outOfDate.hint')}`,
    );
    expect(shownKeys()[0]).toMatch(/^A2/);
    expect((await cellsOf('A1'))[1]).toHaveTextContent('2');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await spoken()).toEqual([
      'polite: orders has changed elsewhere. Reload to see the changes.',
    ]);

    // A second burst: the notice keeps count, nothing more is said.
    await virtual.clearSpokenPhraseLog();
    await hearChange(
      queryClient,
      tableOf([row('r4', { order_id: 'A4', qty: 1 }), ...CHANGED.rows]),
    );
    await waitFor(async () =>
      expect(await notice()).toHaveTextContent('2 rows added'),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await spoken()).toEqual([]);
    await expectNoA11yViolations(document.body);
  });

  it('marks a row changed elsewhere in words, and will not edit it', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const queryClient = renderView();
    await cellsOf('A1');
    await hearChange(queryClient, CHANGED);
    await notice();

    const [key, qty] = await cellsOf('A1');
    expect(key).toHaveTextContent(`A1${t('records.changedElsewhere')}`);
    await user.click(qty);
    expect(within(qty).queryByRole('spinbutton')).toBeNull();

    // A row that hasn't changed still edits.
    const [, otherQty] = await cellsOf('A2');
    await user.click(otherQty);
    expect(await within(otherQty).findByRole('spinbutton')).toBeVisible();
  });

  it('reloads from the notice, clearing it and its marks, and keeps focus in the sheet', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const queryClient = renderView();
    await cellsOf('A1');
    await hearChange(queryClient, CHANGED);

    await user.click(
      within(await notice()).getByRole('button', {
        name: t('records.outOfDate.reload'),
      }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole('group', { name: t('records.outOfDate.label') }),
      ).toBeNull(),
    );
    await waitFor(() => expect(shownKeys()[0]).toMatch(/^A3/));
    expect((await cellsOf('A1'))[0]).not.toHaveTextContent(
      t('records.changedElsewhere'),
    );
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole('grid')).toContainElement(
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null,
    );
  });

  it('turns read-only, keeping Reload, once its columns change elsewhere (001.06)', async () => {
    const queryClient = renderView();
    await cellsOf('A1');
    await virtual.clearSpokenPhraseLog();

    // A person renamed qty to amount: every row is rewritten, and the columns differ.
    const renamed: RecordTableRows = {
      ...tableOf([
        row('r2', { order_id: 'A2', amount: 5 }, 2),
        row('r1', { order_id: 'A1', amount: 2 }, 2),
      ]),
    };
    renamed.definition = {
      ...renamed.definition,
      schema: {
        properties: {
          order_id: { type: 'string' },
          amount: { type: 'integer' },
        },
        required: ['order_id', 'amount'],
      },
    };
    await hearChange(queryClient, renamed, 'alter_table');

    const shown = await notice();
    expect(shown).toHaveTextContent(t('records.outOfDate.columns'));
    expect(
      screen.getByRole('button', {
        name: t('records.addRow', { table: 'orders' }),
      }),
    ).toBeDisabled();
    // Nothing on screen moves or is renamed until the reader asks.
    expect(shownKeys().map((k) => k?.slice(0, 2))).toEqual(['A2', 'A1']);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await spoken()).toEqual([
      'polite: The columns of orders have changed elsewhere. Reload to see them.',
    ]);

    await userEvent.click(
      within(shown).getByRole('button', {
        name: t('records.outOfDate.reload'),
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('group', { name: t('records.outOfDate.label') }),
      ).toBeNull(),
    );
    expect(
      screen.getByRole('columnheader', { name: /amount/ }),
    ).toBeInTheDocument();
  });

  it('turns read-only, with no reload, once the table is deleted elsewhere', async () => {
    const queryClient = renderView();
    await cellsOf('A1');
    await virtual.clearSpokenPhraseLog();

    await hearChange(
      queryClient,
      { status: 404, body: { message: 'no such table' } },
      'drop_table',
    );

    const shown = await notice();
    expect(shown).toHaveTextContent(t('records.outOfDate.dropped'));
    expect(within(shown).queryByRole('button')).toBeNull();
    expect(
      screen.getByRole('button', {
        name: t('records.addRow', { table: 'orders' }),
      }),
    ).toBeDisabled();
    expect(
      screen.queryByRole('button', {
        name: t('records.more', { table: 'orders' }),
      }),
    ).toBeNull();
    // Still readable: the rows stay as they were.
    expect(shownKeys().map((k) => k?.slice(0, 2))).toEqual(['A2', 'A1']);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await spoken()).toEqual(['polite: orders was deleted elsewhere.']);
  });
});
