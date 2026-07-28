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
