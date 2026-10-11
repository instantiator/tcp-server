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
    'describe_folder_resources',
    'resources_read_only',
    'resources_none',
    'resources_create_hint',
    'resources_more',
    'resources_no_folder',
    'resources_is_file',
    'resources_is_folder',
    'resources_no_resource',
    'resources_no_resource_empty',
    'resources_did_you_mean',
    'resources_binary',
    'resources_created',
    'resources_replaced',
    'resources_appended',
    'resources_replaced_count',
    'resources_draft_note',
    'resources_new_folder_hint',
  ];

  it.each(keys)('"%s" is a non-empty string', (key) => {
    expect(typeof storagePrompts[key]).toBe('string');
    expect(storagePrompts[key].length).toBeGreaterThan(0);
  });
});
