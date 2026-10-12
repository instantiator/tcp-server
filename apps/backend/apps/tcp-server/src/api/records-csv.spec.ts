import { RecordsError, type TableDefinition } from '@tcp/shared';
import { parseCsv, toCsv } from './records-csv';

const ORDERS: TableDefinition = {
  id: 't1',
  name: 'orders',
  purpose: 'Orders',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      order_id: { type: 'string' },
      qty: { type: 'integer' },
      total: { type: 'number' },
      paid: { type: 'boolean' },
      note: { type: 'string' },
    },
    required: ['order_id', 'qty'],
  },
  primaryKey: ['order_id'],
  uniqueKeys: [],
  retention: null,
};

describe('records CSV', () => {
  it('writes the key first, then the fields alphabetically, quoting what needs it', () => {
    const csv = toCsv(
      ORDERS,
      [
        {
          order_id: 'A1',
          qty: 2,
          total: 9.5,
          paid: true,
          note: 'say "hi", ok',
        },
        { order_id: 'A2', qty: 1 },
      ],
      true,
    );
    expect(csv).toBe(
      'order_id,note,paid,qty,total\nA1,"say ""hi"", ok",true,2,9.5\nA2,,,1,\n',
    );
  });

  it('round-trips through parse, keeping types and leaving empty cells out', () => {
    const rows = [
      { order_id: 'A1', qty: 2, total: 9.5, paid: true, note: 'line\nbreak' },
      { order_id: 'A2', qty: 1 },
    ];
    expect(parseCsv(ORDERS, toCsv(ORDERS, rows, true))).toEqual({
      rows,
      errors: [],
    });
  });

  it.each(['=SUM(A1)', '+1', '-2', '@cmd', '\tx'])(
    'guards a formula-like text cell %j on export, and removes the guard on import',
    (note) => {
      const row = { order_id: 'A1', qty: 1, note };
      const csv = toCsv(ORDERS, [row], true);
      expect(csv).toContain(`'${note}`);
      expect(parseCsv(ORDERS, csv).rows).toEqual([row]);
    },
  );

  it('keeps a leading quote that guards nothing', () => {
    expect(
      parseCsv(ORDERS, "order_id,qty,note\nA1,1,'tis\n").rows[0]['note'],
    ).toBe("'tis");
  });

  it('accepts a BOM, columns in any order and optional columns left out', () => {
    expect(parseCsv(ORDERS, '\uFEFFqty,order_id\n3,A9\n').rows).toEqual([
      { order_id: 'A9', qty: 3 },
    ]);
  });

  it('reads yes/no and 1/0 as booleans', () => {
    const { rows } = parseCsv(ORDERS, 'order_id,qty,paid\nA,1,Yes\nB,1,0\n');
    expect(rows.map((r) => r['paid'])).toEqual([true, false]);
  });

  it('names each bad cell with its spreadsheet row', () => {
    const { errors } = parseCsv(
      ORDERS,
      'order_id,qty,total,paid\nA,1,1,true\nB,1.5,x,maybe\nC,2,,\n',
    );
    expect(errors).toEqual([
      {
        row: 3,
        message:
          "qty must be a whole number, not '1.5'; total must be a number, not 'x'; paid must be true or false, not 'maybe'",
      },
    ]);
  });

  it.each([
    [
      'an unknown column',
      'order_id,colour\nA,red\n',
      /unknown column 'colour'/,
    ],
    ['an empty file', '', /empty/],
    ['broken quoting', 'order_id\n"A\n', /isn't valid CSV/],
  ])('refuses %s', (_label, text, message) => {
    expect(() => parseCsv(ORDERS, text)).toThrow(RecordsError);
    expect(() => parseCsv(ORDERS, text)).toThrow(message);
  });
});
