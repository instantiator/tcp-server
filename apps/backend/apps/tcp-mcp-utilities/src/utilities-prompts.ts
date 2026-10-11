import * as fs from 'fs';
import * as path from 'path';
import JSON5 from 'json5';

/** Prompts and fixed strings for the tcp-mcp-utilities service. */
export interface UtilitiesPrompts {
  describe_server: string;
}

/** Loaded once at module initialisation from the co-located {@link prompts.jsonc} file. */
export const utilitiesPrompts: UtilitiesPrompts = JSON5.parse(
  fs.readFileSync(path.join(__dirname, 'prompts.jsonc'), 'utf-8'),
);
