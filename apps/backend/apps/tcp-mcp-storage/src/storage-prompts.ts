import * as fs from 'fs';
import * as path from 'path';
import JSON5 from 'json5';

/** Prompts and fixed strings for the tcp-mcp-storage service. */
export interface StoragePrompts {
  describe_server: string;
  describe_folder_task_materials: string;
  describe_folder_task_completed: string;
  describe_folder_assignment_working: string;
  describe_folder_assignment_completed: string;
  describe_folder_knowledge: string;
  describe_folder_audit: string;
  describe_folder_fallback: string;
  describe_folder_resources: string;
  resources_read_only: string;
  resources_none: string;
  resources_create_hint: string;
  resources_more: string;
  resources_no_folder: string;
  resources_is_file: string;
  resources_is_folder: string;
  resources_no_resource: string;
  resources_no_resource_empty: string;
  resources_did_you_mean: string;
  resources_binary: string;
  resources_created: string;
  resources_replaced: string;
  resources_appended: string;
  resources_replaced_count: string;
  resources_draft_note: string;
  resources_new_folder_hint: string;
}

/** Loaded once at module initialisation from the co-located {@link prompts.jsonc} file. */
export const storagePrompts: StoragePrompts = JSON5.parse(
  fs.readFileSync(path.join(__dirname, 'prompts.jsonc'), 'utf-8'),
);

/**
 * Message returned when a mutating tool is called against a read-only storage
 * scope. Names the refused tool and the read-only tools available instead, so
 * the agent can inspect (but not change) the files. A plain function — we have
 * no templating engine, and one string doesn't warrant adding one.
 */
export function getReadOnlyMessage(
  toolName: string,
  readOnlyTools: string[],
): string {
  return (
    `${toolName} is not available in this mode. The directory is read-only. ` +
    `Use these tools to inspect files: ${readOnlyTools.join(', ')}.`
  );
}
