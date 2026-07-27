import { validateJson } from './json-validator';

describe('validateJson', () => {
  it('accepts valid JSON with no $schema', async () => {
    const result = await validateJson('{"name": "acme"}', { path: 'a.json' });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects malformed JSON syntax', async () => {
    const result = await validateJson('{"name": ', { path: 'a.json' });
    expect(result.valid).toBe(false);
    expect(result.errors[0].llmHint).toMatch(/not valid JSON/);
  });

  it('accepts JSON that satisfies a local $schema', async () => {
    const schema = JSON.stringify({
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    });
    const resolveRef = jest.fn().mockResolvedValue(schema);
    const result = await validateJson(
      '{"$schema": "./thing.schema.json", "name": "acme"}',
      { path: 'a.json', resolveRef },
    );
    expect(result.valid).toBe(true);
    expect(resolveRef).toHaveBeenCalledWith('./thing.schema.json');
  });

  it('rejects JSON that violates its own local $schema', async () => {
    const schema = JSON.stringify({
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    });
    const resolveRef = jest.fn().mockResolvedValue(schema);
    const result = await validateJson('{"$schema": "./thing.schema.json"}', {
      path: 'a.json',
      resolveRef,
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0].llmHint).toMatch(/thing\.schema\.json/);
  });

  it('does not fetch a remote $schema URL', async () => {
    const resolveRef = jest.fn();
    const result = await validateJson(
      '{"$schema": "https://example.com/schema.json", "name": "acme"}',
      { path: 'a.json', resolveRef },
    );
    expect(result.valid).toBe(true);
    expect(resolveRef).not.toHaveBeenCalled();
  });

  it('treats an unresolvable local $schema as structurally valid', async () => {
    const resolveRef = jest.fn().mockResolvedValue(null);
    const result = await validateJson(
      '{"$schema": "./missing.schema.json", "name": "acme"}',
      { path: 'a.json', resolveRef },
    );
    expect(result.valid).toBe(true);
  });
});
