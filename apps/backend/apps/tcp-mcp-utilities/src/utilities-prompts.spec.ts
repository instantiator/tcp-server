import { utilitiesPrompts } from './utilities-prompts';
import { utilitiesToolDescriptions } from './utilities-tool-descriptions';

describe('utilities jsonc loaders', () => {
  it('"describe_server" prompt is a non-empty string', () => {
    expect(utilitiesPrompts.describe_server.length).toBeGreaterThan(0);
  });

  it.each([
    'describe_server',
    'calculate',
    'date_math',
    'convert_units',
  ] as const)('tool description "%s" is a non-empty string', (key) => {
    expect(typeof utilitiesToolDescriptions[key]).toBe('string');
    expect(utilitiesToolDescriptions[key].length).toBeGreaterThan(0);
  });
});
