import { storagePrompts } from './storage-prompts';

describe('storagePrompts loader', () => {
  const keys: (keyof typeof storagePrompts)[] = [
    'describe_server',
    'describe_folder_task_materials',
    'describe_folder_task_output',
    'describe_folder_knowledge',
    'describe_folder_finished_reports',
    'describe_folder_finished_specifications',
    'describe_folder_finished_designs',
    'describe_folder_finished_code',
    'describe_folder_finished_other',
    'describe_folder_audit',
    'describe_folder_fallback',
  ];

  it.each(keys)('"%s" is a non-empty string', (key) => {
    expect(typeof storagePrompts[key]).toBe('string');
    expect(storagePrompts[key].length).toBeGreaterThan(0);
  });
});
