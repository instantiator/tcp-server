import { str } from './wire-parse';

describe('str', () => {
  it('reads a string field', () => {
    expect(str({ newStatus: 'failed' }, 'newStatus')).toBe('failed');
  });

  it('is empty for a missing key, an undefined record, or a non-string value', () => {
    expect(str({}, 'newStatus')).toBe('');
    expect(str(undefined, 'newStatus')).toBe('');
    expect(str({ newStatus: 7 }, 'newStatus')).toBe('');
  });
});
