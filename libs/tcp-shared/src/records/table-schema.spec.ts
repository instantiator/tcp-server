import { RecordsError, type TableDefinition } from './records.types';
import {
  RECORD_LIMITS,
  checkAddColumn,
  checkDelete,
  checkNewKey,
  checkRename,
} from './table-schema';

/** A feedings table like the one that prompted 001.06: keyed on date and time, with no animal. */
function feedings(extra: Partial<TableDefinition> = {}): TableDefinition {
  return {
    id: 't1',
    name: 'feedings',
    purpose: 'When the animals were fed',
    schema: {
      type: 'object',
      properties: {
        feeding_date: { type: 'string', format: 'date' },
        feeding_time: { type: 'string' },
        animal: { type: 'string' },
        portion: { type: 'number' },
        fed: { type: 'boolean' },
        tag: { type: 'string' },
      },
      required: ['feeding_date', 'feeding_time'],
      additionalProperties: false,
    },
    primaryKey: ['feeding_date', 'feeding_time'],
    uniqueKeys: [['tag']],
    retention: { days: 30, from: 'feeding_date' },
    ...extra,
  };
}

describe('checkAddColumn', () => {
  const add = (change: object, records = 2) =>
    checkAddColumn(
      feedings(),
      { op: 'add_column', column: 'notes', type: 'string', ...change },
      records,
    );

  it('returns the field schema, keeping only the given keywords', () => {
    expect(add({})).toEqual({ type: 'string' });
    expect(
      add({ column: 'given_on', format: 'date', description: 'when' }),
    ).toEqual({ type: 'string', format: 'date', description: 'when' });
  });

  it('refuses a bad or taken name, naming the fix', () => {
    expect(() => add({ column: 'Notes' })).toThrow(/lower case/);
    expect(() => add({ column: 'animal' })).toThrow(
      /already has a column named 'animal'/,
    );
  });

  it('refuses a column past the field limit', () => {
    const full = feedings();
    for (let i = 0; i < RECORD_LIMITS.fieldsPerTable; i++) {
      full.schema.properties[`f${i}`] = { type: 'string' };
    }
    expect(() =>
      checkAddColumn(
        full,
        { op: 'add_column', column: 'more', type: 'string' },
        0,
      ),
    ).toThrow(/at most 50 columns/);
  });

  it('refuses an unknown type or format, and a date that is not text', () => {
    expect(() => add({ type: 'object' })).toThrow(/type must be/);
    expect(() => add({ format: 'email' })).toThrow(/format can only be/);
    expect(() => add({ type: 'integer', format: 'date' })).toThrow(
      /date column must have type string/,
    );
  });

  it('refuses a default that does not fit the column', () => {
    expect(() => add({ type: 'integer', default: 'two' })).toThrow(
      /default "two" doesn't fit/,
    );
    expect(() => add({ type: 'integer', default: 1.5 })).toThrow(/doesn't fit/);
    expect(() => add({ format: 'date', default: '12/10/2026' })).toThrow(
      /doesn't fit/,
    );
    expect(add({ type: 'integer', default: 2 })).toEqual({ type: 'integer' });
  });

  it('allows required only when every record gets a value', () => {
    expect(() => add({ required: true })).toThrow(/give a default/);
    expect(() => add({ required: true, default: 'none' })).not.toThrow();
    expect(() => add({ required: true }, 0)).not.toThrow();
  });
});

describe('checkRename', () => {
  it('refuses an unknown column, listing the real ones', () => {
    expect(() => checkRename(feedings(), 'aminal', 'species')).toThrow(
      /no column named 'aminal'; its columns are feeding_date/,
    );
  });

  it('refuses the same name, a taken name and a bad name', () => {
    expect(() => checkRename(feedings(), 'animal', 'animal')).toThrow(
      /already has that name/,
    );
    expect(() => checkRename(feedings(), 'animal', 'tag')).toThrow(
      /already has a column named 'tag'/,
    );
    expect(() => checkRename(feedings(), 'animal', '2animal')).toThrow(
      /lower case/,
    );
  });

  it('allows renaming a key field', () => {
    expect(() =>
      checkRename(feedings(), 'feeding_time', 'fed_at'),
    ).not.toThrow();
  });
});

describe('checkDelete', () => {
  it('refuses a primary key field, saying to change the key first', () => {
    expect(() => checkDelete(feedings(), 'feeding_time')).toThrow(
      /in the primary key .*take it out of the key first/,
    );
  });

  it('refuses a unique key field and the retention field', () => {
    expect(() => checkDelete(feedings(), 'tag')).toThrow(/unique key/);
    expect(() => checkDelete(feedings(), 'feeding_date')).toThrow(
      /primary key/,
    );
    const byOther = feedings({ primaryKey: ['feeding_time'] });
    expect(() => checkDelete(byOther, 'feeding_date')).toThrow(
      /kept for 30 days from 'feeding_date'/,
    );
  });

  it('allows any other column', () => {
    expect(() => checkDelete(feedings(), 'portion')).not.toThrow();
  });
});

describe('checkNewKey', () => {
  it('widens a key, for agents too, without asking for required up front', () => {
    expect(
      checkNewKey(
        feedings(),
        ['feeding_date', 'feeding_time', 'animal'],
        false,
      ),
    ).toEqual(['feeding_date', 'feeding_time', 'animal']);
  });

  it('refuses float, boolean, unknown and repeated fields', () => {
    expect(() => checkNewKey(feedings(), ['portion'], true)).toThrow(
      /must be a string or integer, not number/,
    );
    expect(() => checkNewKey(feedings(), ['fed'], true)).toThrow(/not boolean/);
    expect(() => checkNewKey(feedings(), ['nope'], true)).toThrow(
      /not a field/,
    );
    expect(() => checkNewKey(feedings(), ['animal', 'animal'], true)).toThrow(
      /names a field twice/,
    );
    expect(() => checkNewKey(feedings(), [], true)).toThrow(/non-empty/);
  });

  it('refuses the current key, in any order, and an existing unique key', () => {
    expect(() =>
      checkNewKey(feedings(), ['feeding_time', 'feeding_date'], true),
    ).toThrow(/already feeding_date, feeding_time/);
    expect(() => checkNewKey(feedings(), ['tag'], true)).toThrow(
      /already a unique key/,
    );
  });

  it('lets people narrow a key, but tells agents to ask a person', () => {
    expect(checkNewKey(feedings(), ['feeding_date'], true)).toEqual([
      'feeding_date',
    ]);
    let error: unknown;
    try {
      checkNewKey(feedings(), ['feeding_date', 'animal'], false);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RecordsError);
    expect((error as RecordsError).message).toMatch(
      /taking feeding_time out of the key .*request_user_input/,
    );
  });
});
