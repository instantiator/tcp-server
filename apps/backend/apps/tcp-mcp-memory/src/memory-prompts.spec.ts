import { memoryPrompts } from './memory-prompts';

describe('memoryPrompts loader', () => {
  const keys: (keyof typeof memoryPrompts)[] = [
    'describe_server',
    'no_embedding_config',
    'no_embedding_config_store',
    'no_results',
    'memory_stored',
    'memory_replaced',
    'memory_duplicate',
    'memory_replace_not_found',
  ];

  it.each(keys)('"%s" is a non-empty string', (key) => {
    expect(typeof memoryPrompts[key]).toBe('string');
    expect(memoryPrompts[key].length).toBeGreaterThan(0);
  });

  it('memory_stored contains the {{id}} placeholder', () => {
    expect(memoryPrompts.memory_stored).toContain('{{id}}');
  });

  it('memory_duplicate quotes the existing memory and names `replaces`', () => {
    expect(memoryPrompts.memory_duplicate).toContain('{{id}}');
    expect(memoryPrompts.memory_duplicate).toContain('{{content}}');
    expect(memoryPrompts.memory_duplicate).toContain('`replaces`');
  });
});
