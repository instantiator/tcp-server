import * as fs from 'fs';
import * as path from 'path';
import JSON5 from 'json5';

/** Tool names and descriptions for the tcp-mcp-records service. */
export interface RecordsToolDescriptions {
  describe_server: string;
  list_tables: string;
  describe_table: string;
  create_table: string;
  insert: string;
  update: string;
  delete: string;
  query: string;
  aggregate: string;
  alter_table: string;
  do_not_store: string;
}

/** Loaded once at module initialisation from the co-located {@link tools.jsonc} file. */
export const recordsToolDescriptions: RecordsToolDescriptions = JSON5.parse(
  fs.readFileSync(path.join(__dirname, 'tools.jsonc'), 'utf-8'),
);
