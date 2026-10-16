import { recordsPrompts } from './records-prompts';
import { recordsToolDescriptions } from './records-tool-descriptions';

describe('records jsonc loaders', () => {
  it.each(['describe_server', 'no_tables', 'already_exists'] as const)(
    'prompt "%s" is a non-empty string',
    (key) => {
      expect(recordsPrompts[key].length).toBeGreaterThan(0);
    },
  );

  it('delete_column_ask_user names the column and table, and the tool to use', () => {
    expect(recordsPrompts.delete_column_ask_user).toContain('{{column}}');
    expect(recordsPrompts.delete_column_ask_user).toContain('{{table}}');
    expect(recordsPrompts.delete_column_ask_user).toContain(
      'request_user_input',
    );
  });

  it('unique_key_ask_user names the fields and table, and the tool to use', () => {
    expect(recordsPrompts.unique_key_ask_user).toContain('{{fields}}');
    expect(recordsPrompts.unique_key_ask_user).toContain('{{table}}');
    expect(recordsPrompts.unique_key_ask_user).toContain('request_user_input');
  });

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
