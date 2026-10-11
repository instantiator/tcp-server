import * as fs from 'fs';
import * as path from 'path';
import JSON5 from 'json5';

/** Prompts and fixed strings for the tcp-mcp-records service. */
export interface RecordsPrompts {
  describe_server: string;
  no_tables: string;
  already_exists: string;
}

/** Loaded once at module initialisation from the co-located {@link prompts.jsonc} file. */
export const recordsPrompts: RecordsPrompts = JSON5.parse(
  fs.readFileSync(path.join(__dirname, 'prompts.jsonc'), 'utf-8'),
);
