import { interactionPrompts } from './interactions-prompts';

describe('interactionPrompts loader', () => {
  const keys: (keyof typeof interactionPrompts)[] = [
    'describe_server',
    'paused_user_input',
    'error_user_input',
    'paused_consultation',
    'error_consultation',
    'error_list_users',
    'error_list_roles',
  ];

  it.each(keys)('"%s" is a non-empty string', (key) => {
    expect(typeof interactionPrompts[key]).toBe('string');
    expect(interactionPrompts[key].length).toBeGreaterThan(0);
  });

  it('paused_user_input contains the {{slug}} placeholder', () => {
    expect(interactionPrompts.paused_user_input).toContain('{{slug}}');
  });

  it('paused_consultation contains the {{roleName}} and {{consultationId}} placeholders', () => {
    expect(interactionPrompts.paused_consultation).toContain('{{roleName}}');
    expect(interactionPrompts.paused_consultation).toContain(
      '{{consultationId}}',
    );
  });

  it('error_consultation contains the {{roleName}} placeholder', () => {
    expect(interactionPrompts.error_consultation).toContain('{{roleName}}');
  });
});
