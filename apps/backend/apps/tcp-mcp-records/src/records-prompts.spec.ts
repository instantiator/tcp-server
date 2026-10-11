import { recordsPrompts } from './records-prompts';
import { recordsToolDescriptions } from './records-tool-descriptions';

describe('records jsonc loaders', () => {
  it.each(['describe_server', 'no_tables', 'already_exists'] as const)(
    'prompt "%s" is a non-empty string',
    (key) => {
      expect(recordsPrompts[key].length).toBeGreaterThan(0);
    },
  );

  it('already_exists contains the {{key}} placeholder', () => {
    expect(recordsPrompts.already_exists).toContain('{{key}}');
  });

  it.each(Object.keys(recordsToolDescriptions))(
    'tool description "%s" is a non-empty string',
    (key) => {
      expect(
        recordsToolDescriptions[key as keyof typeof recordsToolDescriptions]
          .length,
      ).toBeGreaterThan(0);
    },
  );
});
