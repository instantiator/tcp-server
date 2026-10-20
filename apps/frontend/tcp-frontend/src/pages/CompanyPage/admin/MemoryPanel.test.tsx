import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WireEvent } from '@tcp/shared/client';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announce } from '../../../announce/announcer';
import type { MemoryDto, MemoryList } from '../../../api/dtos';
import { RECORD_CHANGE_WINDOW_MS } from '../../../api/record-changes';
import { applyEvent } from '../../../events/cache';
import { t, tCount } from '../../../strings';
import { expectNoA11yViolations } from '../../../test-support/axe';
import { fetchMock, installFetchMock } from '../../../test-support/fetch-mock';
import { MemoryPanel } from './MemoryPanel';

vi.mock('../../../announce/announcer', () => ({
  announce: vi.fn(),
  ANNOUNCE_IMMEDIATE_MS: 0,
}));

const BASE = '/api/role/r1/memory';
const NOW = '2026-10-20T10:00:00.000Z';

const memory = (
  id: string,
  content: string,
  overrides: Partial<MemoryDto> = {},
): MemoryDto => ({
  id,
  content,
  tags: [],
  agentId: null,
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

/** What the fake server holds; tests change it between requests. */
interface World {
  list: MemoryList;
}

/** Every request as `METHOD path` with its JSON body, for asserting on what was sent. */
const calls: { method: string; path: string; body: unknown }[] = [];

const json = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const serve = (world: World) => {
  fetchMock.mockImplementation(async (input) => {
    if (!(input instanceof Request)) throw new Error('expected a Request');
    const path = new URL(input.url).pathname;
    const text = await input.text();
    const body: unknown = text === '' ? undefined : JSON.parse(text);
    calls.push({ method: input.method, path, body });
    if (input.method === 'GET' && path === BASE) return json(world.list);
    if (input.method === 'POST' && path === BASE) {
      return json(
        memory('new', 'Shop shuts at five', { tags: ['hours'] }),
        201,
      );
    }
    if (input.method === 'PATCH') {
      return json(memory('m1', 'Tea is £4', { version: 2 }));
    }
    if (input.method === 'DELETE') return json(undefined, 204);
    throw new Error(`unexpected ${input.method} ${path}`);
  });
};

const renderPanel = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <main>
          <MemoryPanel roleId="r1" />
        </main>
      </QueryClientProvider>
    </StrictMode>,
  );
  return queryClient;
};

/** A `memory` signal as the company stream sends it. */
const memoryEvent: WireEvent = {
  type: 'audit',
  event: {
    timestamp: NOW,
    companyId: 'c1',
    role: 'agent',
    agentId: null,
    assignmentId: null,
    taskId: null,
    eventType: 'state_change',
    payload: { entity: 'memory', action: 'created', roleId: 'r1' },
  },
};

describe('MemoryPanel', () => {
  let world: World;

  beforeEach(() => {
    installFetchMock();
    calls.length = 0;
    vi.mocked(announce).mockClear();
    world = {
      list: {
        memories: [
          memory('m1', 'Tea is £3', { tags: ['prices', 'tea'] }),
          memory('m2', 'Deliveries come on Tuesdays', { agentId: 'a1' }),
        ],
        truncated: false,
        canWrite: true,
      },
    };
    serve(world);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('says so when the role has no memories yet', async () => {
    world.list = { memories: [], truncated: false, canWrite: true };
    renderPanel();
    expect(
      await screen.findByRole('heading', { name: t('memory.empty') }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    await expectNoA11yViolations(document.body);
  });

  it('lists the memories in the order given, with their tags and who wrote them', async () => {
    renderPanel();
    const rows = await screen.findAllByRole('rowheader');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Tea is £3',
      'Deliveries come on Tuesdays',
    ]);
    const first = rows[0].closest('tr')!;
    expect(within(first).getByText('prices, tea')).toBeInTheDocument();
    expect(within(first).getByText(t('memory.source.person'))).toBeVisible();
    const second = rows[1].closest('tr')!;
    expect(within(second).getByText(t('memory.source.agent'))).toBeVisible();
    await expectNoA11yViolations(document.body);
  });

  it('adds a memory, then puts focus on it and announces it', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(
      await screen.findByRole('button', { name: t('memory.add') }),
    );
    const dialog = screen.getByRole('dialog', {
      name: t('memory.dialog.addHeading'),
    });
    const content = within(dialog).getByLabelText(t('memory.dialog.content'));
    expect(content).toHaveAttribute('maxLength', '2000');
    await user.type(content, 'Shop shuts at five');
    await user.type(
      within(dialog).getByLabelText(t('memory.dialog.tags')),
      ' hours , ',
    );
    await user.click(
      within(dialog).getByRole('button', { name: t('memory.dialog.save') }),
    );

    expect(calls).toContainEqual({
      method: 'POST',
      path: BASE,
      body: { content: 'Shop shuts at five', tags: ['hours'] },
    });
    await waitFor(() =>
      expect(
        screen.getByRole('rowheader', { name: 'Shop shuts at five' }),
      ).toHaveFocus(),
    );
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({ change: 'memory.announce.added' }),
    );
  });

  it('refuses to save an empty memory, and says why', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(
      await screen.findByRole('button', { name: t('memory.add') }),
    );
    const dialog = screen.getByRole('dialog');
    await user.click(
      within(dialog).getByRole('button', { name: t('memory.dialog.save') }),
    );
    expect(
      within(dialog).getByText(t('memory.dialog.contentRequired')),
    ).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('rewords a memory, keeping its tags', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(
      await screen.findByRole('button', {
        name: t('memory.edit', { preview: 'Tea is £3' }),
      }),
    );
    const dialog = screen.getByRole('dialog', {
      name: t('memory.dialog.editHeading'),
    });
    const content = within(dialog).getByLabelText(t('memory.dialog.content'));
    expect(content).toHaveValue('Tea is £3');
    await user.clear(content);
    await user.type(content, 'Tea is £4');
    await user.click(
      within(dialog).getByRole('button', { name: t('memory.dialog.save') }),
    );

    expect(calls).toContainEqual({
      method: 'PATCH',
      path: `${BASE}/m1`,
      body: { content: 'Tea is £4', tags: ['prices', 'tea'] },
    });
    expect(
      await screen.findByRole('rowheader', { name: 'Tea is £4' }),
    ).toBeInTheDocument();
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({ change: 'memory.announce.saved' }),
    );
  });

  it('deletes after confirming, then puts focus on the next memory and announces it', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(
      await screen.findByRole('button', {
        name: t('memory.delete', { preview: 'Tea is £3' }),
      }),
    );
    const confirm = screen.getByRole('alertdialog', {
      name: t('memory.deleteHeading'),
    });
    await user.click(
      within(confirm).getByRole('button', { name: t('memory.deleteConfirm') }),
    );

    expect(calls).toContainEqual({
      method: 'DELETE',
      path: `${BASE}/m1`,
      body: undefined,
    });
    await waitFor(() =>
      expect(
        screen.getByRole('rowheader', { name: 'Deliveries come on Tuesdays' }),
      ).toHaveFocus(),
    );
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({ change: 'memory.announce.deleted' }),
    );
  });

  it('without an embedding model, offers delete but not add or edit', async () => {
    world.list = { ...world.list, canWrite: false };
    renderPanel();
    expect(await screen.findByText(t('memory.noEmbedding'))).toBeVisible();
    expect(screen.queryByRole('button', { name: t('memory.add') })).toBeNull();
    expect(
      screen.queryByRole('button', {
        name: t('memory.edit', { preview: 'Tea is £3' }),
      }),
    ).toBeNull();
    expect(
      screen.getByRole('button', {
        name: t('memory.delete', { preview: 'Tea is £3' }),
      }),
    ).toBeInTheDocument();
  });

  it('says when memories change elsewhere, and shows them on Reload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const queryClient = renderPanel();
    await screen.findByRole('rowheader', { name: 'Tea is £3' });

    world.list = {
      ...world.list,
      memories: [
        memory('m3', 'Closed on bank holidays', { agentId: 'a1' }),
        ...world.list.memories,
      ],
    };
    act(() => applyEvent(queryClient, memoryEvent));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECORD_CHANGE_WINDOW_MS);
    });

    const notice = await screen.findByRole('group', {
      name: t('records.outOfDate.label'),
    });
    expect(notice).toHaveTextContent(tCount('memory.outOfDate.added', 1));
    // Nothing moves under the reader until they ask.
    expect(
      screen.queryByRole('rowheader', { name: 'Closed on bank holidays' }),
    ).toBeNull();
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({
        change: 'memory.announce.outOfDate',
        channel: 'memory',
      }),
    );

    await user.click(
      within(notice).getByRole('button', {
        name: t('records.outOfDate.reload'),
      }),
    );
    expect(
      await screen.findByRole('rowheader', { name: 'Closed on bank holidays' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: t('memory.heading') }),
    ).toHaveFocus();
    await waitFor(() =>
      expect(
        screen.queryByRole('group', { name: t('records.outOfDate.label') }),
      ).toBeNull(),
    );
  });
});
