import * as fs from 'fs';
import * as path from 'path';
import JSON5 from 'json5';

/** Tool names and descriptions for the lcp-mcp-storage service. */
export interface StorageToolDescriptions {
  describe_server: string;
  describe_folder: string;
  list_files: string;
  read_file: string;
  write_file: string;
  delete_file: string;
  restore_file: string;
  search_files: string;
  get_file_properties: string;
  copy_file: string;
  move_file: string;
  get_file_summary: string;
}

/** Loaded once at module initialisation from the co-located {@link tools.jsonc} file. */
export const storageToolDescriptions: StorageToolDescriptions = JSON5.parse(
  fs.readFileSync(path.join(__dirname, 'tools.jsonc'), 'utf-8'),
);
