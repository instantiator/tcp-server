import { validateXml } from './xml-validator';

describe('validateXml', () => {
  it('accepts well-formed XML', () => {
    const result = validateXml('<root><child>1</child></root>');
    expect(result.valid).toBe(true);
  });

  it('rejects malformed/unclosed-tag XML', () => {
    const result = validateXml('<root><child>1</child>');
    expect(result.valid).toBe(false);
    expect(result.errors[0].llmHint).toMatch(/not well-formed XML/);
  });
});
