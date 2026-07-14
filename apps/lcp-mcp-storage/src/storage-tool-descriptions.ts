import * as fs from 'fs';
import * as path from 'path';
import JSON5 from 'json5';

/** Tool names and descriptions for the lcp-mcp-storage service. */
export interface StorageToolDescriptions {
  describe_server: string;
  describe_folder: string;
  list_files: string;
  read_file: string;
  search_files: string;
  get_file_properties: string;
  get_file_summary: string;
  list_working_files: string;
  get_working_file_properties: string;
  read_working_file: string;
  append_working_file: string;
  replace_in_working_file: string;
  delete_working_file: string;
  restore_working_file: string;
  rename_working_file: string;
  list_material_files: string;
  get_material_file_properties: string;
  read_material_file: string;
}

/** Loaded once at module initialisation from the co-located {@link tools.jsonc} file. */
export const storageToolDescriptions: StorageToolDescriptions = JSON5.parse(
  fs.readFileSync(path.join(__dirname, 'tools.jsonc'), 'utf-8'),
);
