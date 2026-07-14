import { taskPrompts } from './tasks-prompts';

describe('taskPrompts loader', () => {
  const keys: (keyof typeof taskPrompts)[] = [
    'describe_header',
    'current_mode',
    'plan_created',
    'assignment_completed',
    'assignment_assured',
    'error_wrong_mode',
    'error_no_assignment',
    'error_create_plan',
    'error_complete_assignment',
    'error_assure_assignment',
  ];

  it.each(keys)('"%s" is a non-empty string', (key) => {
    expect(typeof taskPrompts[key]).toBe('string');
    expect(taskPrompts[key].length).toBeGreaterThan(0);
  });

  it('plan_created contains the {{count}} placeholder', () => {
    expect(taskPrompts.plan_created).toContain('{{count}}');
  });

  it('error_wrong_mode contains the {{mode}} and {{tool}} placeholders', () => {
    expect(taskPrompts.error_wrong_mode).toContain('{{mode}}');
    expect(taskPrompts.error_wrong_mode).toContain('{{tool}}');
  });
});
