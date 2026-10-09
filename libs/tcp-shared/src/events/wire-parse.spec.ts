import {
  parseTaskChangeSummary,
  planIndexFromShortcode,
  str,
} from './wire-parse';

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

describe('planIndexFromShortcode', () => {
  it('reads the plan index out of the middle segment', () => {
    expect(planIndexFromShortcode('000-001-implement')).toBe(1);
    expect(planIndexFromShortcode('000-000-plan')).toBe(0);
  });

  it('is null for a null shortcode (an orphan assignment)', () => {
    expect(planIndexFromShortcode(null)).toBeNull();
  });

  it('is null for a shape this client does not recognise', () => {
    expect(planIndexFromShortcode('000')).toBeNull();
    expect(planIndexFromShortcode('000-abc-implement')).toBeNull();
    expect(planIndexFromShortcode('000-1.5-implement')).toBeNull();
  });
});

describe('parseTaskChangeSummary', () => {
  const summary = {
    id: 'task-1',
    status: 'in-progress',
    request: 'Write a report',
    shortcode: '000',
    createdAt: '2026-07-03T10:00:00.000Z',
    updatedAt: '2026-07-03T11:00:00.000Z',
    completedSteps: 2,
    totalSteps: 5,
  };

  it('passes a well-formed summary through', () => {
    expect(parseTaskChangeSummary(summary)).toEqual({
      ...summary,
      pausedAt: null,
      pausedBy: null,
      visualisationClosedAt: null,
    });
  });

  it('rejects a summary missing its required fields', () => {
    expect(parseTaskChangeSummary(undefined)).toBeNull();
    expect(parseTaskChangeSummary({})).toBeNull();
    expect(parseTaskChangeSummary({ id: 'task-1' })).toBeNull();
    expect(parseTaskChangeSummary({ status: 'ready' })).toBeNull();
  });

  it('defaults every optional field rather than passing a wrong type on', () => {
    expect(
      parseTaskChangeSummary({
        id: 'task-1',
        status: 'ready',
        updatedAt: 12345,
        completedSteps: '2',
      }),
    ).toEqual({
      id: 'task-1',
      status: 'ready',
      request: '',
      shortcode: '',
      createdAt: '',
      updatedAt: '',
      completedSteps: 0,
      totalSteps: 0,
      pausedAt: null,
      pausedBy: null,
      visualisationClosedAt: null,
    });
  });
});
