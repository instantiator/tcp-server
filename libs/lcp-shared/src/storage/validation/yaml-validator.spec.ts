import { validateYaml } from './yaml-validator';

describe('validateYaml', () => {
  it('accepts valid YAML with no $schema', async () => {
    const result = await validateYaml('name: acme\n', { path: 'a.yaml' });
    expect(result.valid).toBe(true);
  });

  it('rejects malformed YAML syntax', async () => {
    const result = await validateYaml('name: [unclosed\n', { path: 'a.yaml' });
    expect(result.valid).toBe(false);
    expect(result.errors[0].llmHint).toMatch(/not valid YAML/);
  });

  it('accepts YAML that satisfies a local $schema referenced via a top-level key', async () => {
    const schema = JSON.stringify({
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    });
    const resolveRef = jest.fn().mockResolvedValue(schema);
    const result = await validateYaml(
      '$schema: ./thing.schema.json\nname: acme\n',
      { path: 'a.yaml', resolveRef },
    );
    expect(result.valid).toBe(true);
  });

  it('accepts YAML that satisfies a local $schema referenced via a yaml-language-server comment', async () => {
    const schema = JSON.stringify({
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    });
    const resolveRef = jest.fn().mockResolvedValue(schema);
    const result = await validateYaml(
      '# yaml-language-server: $schema=./thing.schema.json\nname: acme\n',
      { path: 'a.yaml', resolveRef },
    );
    expect(result.valid).toBe(true);
    expect(resolveRef).toHaveBeenCalledWith('./thing.schema.json');
  });

  it('rejects YAML that violates a satisfied local $schema', async () => {
    const schema = JSON.stringify({
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    });
    const resolveRef = jest.fn().mockResolvedValue(schema);
    const result = await validateYaml('$schema: ./thing.schema.json\n', {
      path: 'a.yaml',
      resolveRef,
    });
    expect(result.valid).toBe(false);
  });

  it('does not fetch a remote $schema URL', async () => {
    const resolveRef = jest.fn();
    const result = await validateYaml(
      '$schema: https://example.com/schema.json\nname: acme\n',
      { path: 'a.yaml', resolveRef },
    );
    expect(result.valid).toBe(true);
    expect(resolveRef).not.toHaveBeenCalled();
  });
});
