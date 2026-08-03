import { storagePrompts } from './storage-prompts';

describe('storagePrompts loader', () => {
  const keys: (keyof typeof storagePrompts)[] = [
    'describe_server',
    'describe_folder_task_materials',
    'describe_folder_task_completed',
    'describe_folder_assignment_working',
    'describe_folder_assignment_completed',
    'describe_folder_knowledge',
    'describe_folder_audit',
    'describe_folder_fallback',
  ];

  it.each(keys)('"%s" is a non-empty string', (key) => {
    expect(typeof storagePrompts[key]).toBe('string');
    expect(storagePrompts[key].length).toBeGreaterThan(0);
  });
});
