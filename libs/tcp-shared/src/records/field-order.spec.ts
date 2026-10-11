import { fieldOrder } from './field-order';

describe('fieldOrder', () => {
  it('puts the primary key first, in key order, then the rest alphabetically', () => {
    expect(
      fieldOrder({
        primaryKey: ['region', 'order_id'],
        schema: {
          properties: {
            qty: { type: 'integer' },
            order_id: { type: 'string' },
            customer: { type: 'string' },
            region: { type: 'string' },
          },
        },
      }),
    ).toEqual(['region', 'order_id', 'customer', 'qty']);
  });
});
