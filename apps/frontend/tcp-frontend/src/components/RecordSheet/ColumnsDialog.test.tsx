import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordTableDefinition } from '../../api/dtos';
import { t, tCount } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import {
  fetchMock,
  installFetchMock,
  requestedUrls,
  respondByRoute,
} from '../../test-support/fetch-mock';
import { announceRecords } from './announceRecords';
import { ColumnsDialog } from './ColumnsDialog';

vi.mock('./announceRecords', () => ({
  RECORDS_CHANNEL: 'records',
  announceRecords: vi.fn(),
}));

const BASE = '/api/company/c1/records/tables/feedings';

/** The table that prompted 001.06: keyed on when, with nowhere to say which animal. */
const FEEDINGS: RecordTableDefinition = {
  id: 'd1',
  name: 'feedings',
  purpose: 'When the animals were fed',
  primaryKey: ['feeding_date', 'feeding_time'],
  uniqueKeys: [],
  schema: {
    properties: {
      feeding_date: { type: 'string', format: 'date' },
      feeding_time: { type: 'string' },
      portion: { type: 'number' },
      note: { type: 'string' },
    },
    required: ['feeding_date', 'feeding_time'],
  },
  retention: null,
};

/** The method and JSON body of each request to `path`. */
const requestsTo = async (path: RegExp) => {
  const found: { method: string; url: string; body: unknown }[] = [];
  for (const [input] of fetchMock.mock.calls) {
    if (!(input instanceof Request) || !path.test(input.url)) continue;
    const text = await input.clone().text();
    found.push({
      method: input.method,
      url: input.url,
      body: text === '' ? null : (JSON.parse(text) as unknown),
    });
  }
  return found;
};

const renderDialog = (records = 2) => {
  const onClose = vi.fn();
  const onChanged = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ColumnsDialog
        companyId="c1"
        companySlug="acme"
        definition={FEEDINGS}
        records={records}
        onClose={onClose}
        onChanged={onChanged}
      />
    </QueryClientProvider>,
  );
  return { onClose, onChanged };
};

const dialog = () =>
  screen.getByRole('dialog', {
    name: t('records.columns.heading', { table: 'feedings' }),
  });

describe('ColumnsDialog', () => {
  beforeEach(() => {
    installFetchMock();
    vi.mocked(announceRecords).mockReset();
    respondByRoute([[/\/records\//, { body: FEEDINGS }]]);
  });

  it('lists every column with its type in words, key first, and has no accessibility violations', async () => {
    renderDialog();
    const items = within(dialog()).getAllByRole('listitem');
    expect(items.map((li) => li.textContent?.split(' ')[0])).toEqual([
      'feeding_date',
      'feeding_time',
      'note',
      'portion',
    ]);
    expect(items[0]).toHaveTextContent(
      `${t('records.columns.type.date')}, ${t('records.columns.inKey')}, ${t('records.columns.required')}`,
    );
    expect(items[3]).toHaveTextContent(t('records.columns.type.number'));
    await expectNoA11yViolations(document.body);
  });

  it("won't delete a key column, and says why in words beside the button", () => {
    renderDialog();
    const del = within(dialog()).getByRole('button', {
      name: t('records.columns.delete', { column: 'feeding_time' }),
    });
    expect(del).toBeDisabled();
    expect(del).toHaveAccessibleDescription(t('records.columns.keyNoDelete'));
    expect(
      within(dialog()).getByRole('button', {
        name: t('records.columns.delete', { column: 'note' }),
      }),
    ).toBeEnabled();
  });

  it('adds a text column with a value for existing rows, then announces and closes', async () => {
    const user = userEvent.setup();
    const { onClose, onChanged } = renderDialog();
    await user.click(
      within(dialog()).getByRole('button', { name: t('records.columns.add') }),
    );
    const name = within(dialog()).getByRole('textbox', {
      name: t('records.columns.name'),
    });
    expect(name).toHaveFocus();
    await user.type(name, 'animal');
    await user.type(
      within(dialog()).getByRole('textbox', {
        name: t('records.columns.default'),
      }),
      'chicken',
    );
    await user.click(
      within(dialog()).getByRole('checkbox', {
        name: t('records.columns.requiredLabel'),
      }),
    );
    await user.click(
      within(dialog()).getByRole('button', {
        name: t('records.columns.addSubmit'),
      }),
    );

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(await requestsTo(/\/columns$/)).toEqual([
      {
        method: 'POST',
        url: expect.stringContaining(`${BASE}/columns`) as unknown,
        body: {
          column: 'animal',
          type: 'string',
          default: 'chicken',
          required: true,
        },
      },
    ]);
    expect(onChanged).toHaveBeenCalled();
    expect(announceRecords).toHaveBeenCalledWith(
      'records.announce.columnAdded',
      {
        table: 'feedings',
        column: 'animal',
      },
    );
  });

  it('only lets a new column be required when every row gets a value', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(
      within(dialog()).getByRole('button', { name: t('records.columns.add') }),
    );
    const required = within(dialog()).getByRole('checkbox', {
      name: t('records.columns.requiredLabel'),
    });
    expect(required).toBeDisabled();
    expect(dialog()).toHaveTextContent(t('records.columns.requiredHint'));
    await user.type(
      within(dialog()).getByRole('textbox', {
        name: t('records.columns.default'),
      }),
      'x',
    );
    expect(required).toBeEnabled();
  });

  it('sends a whole-number default as a number, and refuses one that is not', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(
      within(dialog()).getByRole('button', { name: t('records.columns.add') }),
    );
    await user.type(
      within(dialog()).getByRole('textbox', {
        name: t('records.columns.name'),
      }),
      'servings',
    );
    await user.click(
      within(dialog()).getByRole('radio', {
        name: t('records.columns.type.integer'),
      }),
    );
    const fallback = within(dialog()).getByRole('textbox', {
      name: t('records.columns.default'),
    });
    await user.type(fallback, '1.5');
    const submit = within(dialog()).getByRole('button', {
      name: t('records.columns.addSubmit'),
    });
    await user.click(submit);
    expect(fallback).toHaveAccessibleDescription(
      expect.stringContaining(t('records.addRow.integer')),
    );
    expect(await requestsTo(/\/columns$/)).toEqual([]);

    await user.clear(fallback);
    await user.type(fallback, '2');
    await user.click(submit);
    await waitFor(async () =>
      expect((await requestsTo(/\/columns$/))[0]?.body).toEqual({
        column: 'servings',
        type: 'integer',
        default: 2,
        required: false,
      }),
    );
  });

  it("shows the server's reason beside the name, and keeps the form open", async () => {
    const user = userEvent.setup();
    respondByRoute([
      [
        /\/columns$/,
        {
          status: 400,
          body: { message: "the table already has a column named 'note'" },
        },
      ],
    ]);
    const { onClose } = renderDialog();
    await user.click(
      within(dialog()).getByRole('button', { name: t('records.columns.add') }),
    );
    const name = within(dialog()).getByRole('textbox', {
      name: t('records.columns.name'),
    });
    await user.type(name, 'note');
    await user.click(
      within(dialog()).getByRole('button', {
        name: t('records.columns.addSubmit'),
      }),
    );
    await waitFor(() =>
      expect(name).toHaveAccessibleDescription(
        expect.stringContaining('already has a column') as unknown as string,
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('asks before storing a default on the do-not-store list', async () => {
    const user = userEvent.setup();
    respondByRoute([
      [
        /\/columns(\?.*)?$/,
        {
          status: 409,
          body: {
            message: 'keeper matches the do-not-store list',
            code: 'do_not_store',
            fields: ['keeper'],
          },
        },
      ],
    ]);
    renderDialog();
    await user.click(
      within(dialog()).getByRole('button', { name: t('records.columns.add') }),
    );
    await user.type(
      within(dialog()).getByRole('textbox', {
        name: t('records.columns.name'),
      }),
      'keeper',
    );
    await user.type(
      within(dialog()).getByRole('textbox', {
        name: t('records.columns.default'),
      }),
      'Jane Doe',
    );
    respondByRoute([
      [/confirmDoNotStore=true/, { status: 201, body: FEEDINGS }],
      [
        /\/columns$/,
        {
          status: 409,
          body: { message: 'x', code: 'do_not_store', fields: ['keeper'] },
        },
      ],
    ]);
    await user.click(
      within(dialog()).getByRole('button', {
        name: t('records.columns.addSubmit'),
      }),
    );
    const ask = await screen.findByRole('alertdialog', {
      name: t('records.doNotStore.heading'),
    });
    expect(ask).toHaveTextContent('keeper');
    await user.click(
      within(ask).getByRole('button', {
        name: t('records.doNotStore.confirm'),
      }),
    );
    await waitFor(() =>
      expect(
        requestedUrls().filter((u) => u.includes('confirmDoNotStore=true')),
      ).toHaveLength(1),
    );
  });

  it('renames a column', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await user.click(
      within(dialog()).getByRole('button', {
        name: t('records.columns.rename', { column: 'note' }),
      }),
    );
    const name = within(dialog()).getByRole('textbox', {
      name: t('records.columns.newName', { column: 'note' }),
    });
    expect(name).toHaveFocus();
    await user.clear(name);
    await user.type(name, 'remark{Enter}');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(await requestsTo(/\/columns\/note$/)).toEqual([
      {
        method: 'PATCH',
        url: expect.stringContaining('/columns/note') as unknown,
        body: { newName: 'remark' },
      },
    ]);
    expect(announceRecords).toHaveBeenCalledWith(
      'records.announce.columnRenamed',
      { table: 'feedings', column: 'note', newName: 'remark' },
    );
  });

  it('asks before deleting a column, with the count and a download, focusing No', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog(3);
    await user.click(
      within(dialog()).getByRole('button', {
        name: t('records.columns.delete', { column: 'note' }),
      }),
    );
    const confirm = await screen.findByRole('alertdialog', {
      name: t('records.columns.deleteHeading', {
        column: 'note',
        table: 'feedings',
      }),
    });
    expect(confirm).toHaveTextContent(
      tCount('records.columns.deleteMessage', 3),
    );
    expect(
      within(confirm).getByRole('button', { name: t('records.downloadFirst') }),
    ).toBeInTheDocument();
    expect(
      within(confirm).getByRole('button', { name: t('confirm.no') }),
    ).toHaveFocus();

    await user.click(
      within(confirm).getByRole('button', {
        name: t('records.columns.deleteConfirm'),
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect((await requestsTo(/\/columns\/note$/))[0]?.method).toBe('DELETE');
  });

  it('changes the key, showing why the rows stop it, then saving once fixed', async () => {
    const user = userEvent.setup();
    const reason =
      "2 records have no value for 'portion', and every key field needs one";
    respondByRoute([
      [/primary-key$/, { status: 400, body: { message: reason } }],
    ]);
    const { onClose } = renderDialog();
    await user.click(
      within(dialog()).getByRole('button', {
        name: t('records.columns.changeKey'),
      }),
    );
    const group = within(dialog()).getByRole('group', {
      name: t('records.columns.keyFields'),
    });
    // A number can't be a key; only text and whole numbers are offered.
    expect(
      within(group)
        .getAllByRole('checkbox')
        .map((c) => c.closest('label')?.textContent),
    ).toEqual(['feeding_date', 'feeding_time', 'note']);
    await user.click(within(group).getByRole('checkbox', { name: 'note' }));
    const save = within(dialog()).getByRole('button', {
      name: t('records.columns.keySubmit'),
    });
    await user.click(save);
    expect(await within(dialog()).findByText(reason)).toBeInTheDocument();
    expect(group).toHaveAccessibleDescription(reason);
    expect(onClose).not.toHaveBeenCalled();

    respondByRoute([[/primary-key$/, { body: FEEDINGS }]]);
    await user.click(save);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect((await requestsTo(/primary-key$/)).map((r) => r.body)).toEqual([
      { fields: ['feeding_date', 'feeding_time', 'note'] },
      { fields: ['feeding_date', 'feeding_time', 'note'] },
    ]);
    expect(announceRecords).toHaveBeenCalledWith(
      'records.announce.keyChanged',
      {
        table: 'feedings',
        fields: 'feeding_date, feeding_time, note',
      },
    );
  });
});
