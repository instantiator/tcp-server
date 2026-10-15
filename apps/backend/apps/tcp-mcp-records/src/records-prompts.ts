import * as fs from 'fs';
import * as path from 'path';
import JSON5 from 'json5';

/** Prompts and fixed strings for the tcp-mcp-records service. */
export interface RecordsPrompts {
  describe_server: string;
  no_tables: string;
  already_exists: string;
  do_not_store_refused: string;
  do_not_store_added: string;
  do_not_store_already: string;
  do_not_store_ask_user: string;
}

/** Loaded once at module initialisation from the co-located {@link prompts.jsonc} file. */
export const recordsPrompts: RecordsPrompts = JSON5.parse(
  fs.readFileSync(path.join(__dirname, 'prompts.jsonc'), 'utf-8'),
);
