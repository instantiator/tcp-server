import { formatTable } from './list-open-queries.action';

describe('list-open-queries formatTable', () => {
  it('returns a no-queries message for an empty list', () => {
    expect(formatTable([])).toBe('No open queries.\n');
  });

  it('includes slug, role, and truncated question', () => {
    const out = formatTable([
      {
        slug: 'analyst-1',
        roleName: 'Analyst',
        question: 'What is the revenue?',
      },
    ]);
    expect(out).toContain('analyst-1');
    expect(out).toContain('Analyst');
    expect(out).toContain('What is the revenue?');
  });

  it('truncates questions longer than 120 chars', () => {
    const longQ = 'x'.repeat(200);
    const out = formatTable([{ slug: 's', roleName: 'r', question: longQ }]);
    expect(out).not.toContain('x'.repeat(121));
    expect(out).toContain('x'.repeat(120));
  });

  it('replaces newlines in questions with spaces', () => {
    const out = formatTable([
      { slug: 's', roleName: 'r', question: 'line one\nline two' },
    ]);
    expect(out).toContain('line one line two');
  });

  it('pads columns to the longest value', () => {
    const out = formatTable([
      { slug: 'ab', roleName: 'r', question: 'q' },
      { slug: 'abcdef', roleName: 'r', question: 'q' },
    ]);
    // SLUG header should be padded to 6 (length of 'abcdef')
    expect(out).toContain('SLUG  ');
  });
});
