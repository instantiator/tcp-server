import { doNotStoreFields, normaliseDoNotStore } from './do-not-store';

describe('doNotStoreFields', () => {
  const entries = ['ann lee', 'bob@example.com', 'josé garcía'].map(
    normaliseDoNotStore,
  );

  it.each([
    ['the exact value', { name: 'Ann Lee' }, ['name']],
    ['any case and spacing', { name: '  ANN \n  lee ' }, ['name']],
    [
      'a phrase inside an address',
      { to: 'Deliver to ann lee, 3 High St' },
      ['to'],
    ],
    ['an email inside text', { note: 'Mail bob@example.com.' }, ['note']],
    ['accented letters', { name: 'José García' }, ['name']],
    ['an accent dropped', { name: 'Jose Garcia' }, ['name']],
    ['several fields', { a: 'Ann Lee', b: 'bob@example.com' }, ['a', 'b']],
  ])('matches %s', (_label, data, fields) => {
    expect(doNotStoreFields(data, entries)).toEqual(fields);
  });

  it.each([
    ['part of a longer word', { name: 'Annlee Ltd' }],
    ['a longer email', { email: 'jbob@example.com' }],
    ['a letter joined on', { name: 'Ann Leeson' }],
    ['a field that is not text', { qty: 1, paid: true }],
  ])('does not match %s', (_label, data) => {
    expect(doNotStoreFields(data, entries)).toEqual([]);
  });

  it('matches nothing when the list is empty', () => {
    expect(doNotStoreFields({ name: 'Ann Lee' }, [])).toEqual([]);
  });
});
