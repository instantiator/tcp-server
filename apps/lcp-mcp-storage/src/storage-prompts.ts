import * as fs from 'fs';
import * as path from 'path';
import JSON5 from 'json5';

/** Prompts and fixed strings for the lcp-mcp-storage service. */
export interface StoragePrompts {
  describe_server: string;
  describe_folder_task_materials: string;
  describe_folder_task_output: string;
  describe_folder_knowledge: string;
  describe_folder_finished_reports: string;
  describe_folder_finished_specifications: string;
  describe_folder_finished_designs: string;
  describe_folder_finished_code: string;
  describe_folder_finished_other: string;
  describe_folder_audit: string;
  describe_folder_fallback: string;
}

/** Loaded once at module initialisation from the co-located {@link prompts.jsonc} file. */
export const storagePrompts: StoragePrompts = JSON5.parse(
  fs.readFileSync(path.join(__dirname, 'prompts.jsonc'), 'utf-8'),
);
