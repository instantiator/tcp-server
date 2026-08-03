import { parseFilters } from './filters';

describe('parseFilters', () => {
  it('returns an empty object for no filters', () => {
    expect(parseFilters()).toEqual({});
    expect(parseFilters([])).toEqual({});
  });

  it('parses a single key=value filter', () => {
    expect(parseFilters(['status=running'])).toEqual({ status: 'running' });
  });

  it('parses multiple filters', () => {
    expect(parseFilters(['status=running', 'role=analyst'])).toEqual({
      status: 'running',
      role: 'analyst',
    });
  });

  it('keeps the last value when a key repeats', () => {
    expect(parseFilters(['task=abc', 'task=null'])).toEqual({ task: 'null' });
  });

  it('splits only on the first "="', () => {
    expect(parseFilters(['assignment=uuid=with=equals'])).toEqual({
      assignment: 'uuid=with=equals',
    });
  });

  it('throws on a filter with no "="', () => {
    expect(() => parseFilters(['status'])).toThrow(
      'Invalid --filter "status", expected key=value',
    );
  });
});
