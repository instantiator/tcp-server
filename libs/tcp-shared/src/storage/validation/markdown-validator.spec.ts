import { validateMarkdown } from './markdown-validator';

describe('validateMarkdown', () => {
  it('is always valid — no strict grammar for plain Markdown', () => {
    expect(validateMarkdown().valid).toBe(true);
  });
});
