import { isOkfPath, validateOkf } from './okf-validator';

describe('isOkfPath', () => {
  it('matches a knowledge-base document path', () => {
    expect(isOkfPath('acme/knowledge/analyst/report.md')).toBe(true);
  });

  it('does not match a plain Markdown path elsewhere', () => {
    expect(isOkfPath('acme/tasks/xyz/output/notes.md')).toBe(false);
  });
});

describe('validateOkf', () => {
  it('accepts a document with front-matter and a title', () => {
    const result = validateOkf('---\ntitle: My Document\n---\n\nBody text.');
    expect(result.valid).toBe(true);
  });

  it('rejects a document with no front-matter', () => {
    const result = validateOkf('# Just a heading\n\nNo front-matter here.');
    expect(result.valid).toBe(false);
    expect(result.errors[0].llmHint).toMatch(/front-matter/);
  });

  it("rejects front-matter missing the 'title' field", () => {
    const result = validateOkf('---\nauthor: me\n---\n\nBody text.');
    expect(result.valid).toBe(false);
  });

  it('rejects front-matter with an empty title', () => {
    const result = validateOkf('---\ntitle: ""\n---\n\nBody text.');
    expect(result.valid).toBe(false);
  });
});
