import * as fs from 'fs';
import * as path from 'path';
import JSON5 from 'json5';

/** Tool names and descriptions for the tcp-mcp-utilities service. */
export interface UtilitiesToolDescriptions {
  describe_server: string;
  calculate: string;
  date_math: string;
  convert_units: string;
}

/** Loaded once at module initialisation from the co-located {@link tools.jsonc} file. */
export const utilitiesToolDescriptions: UtilitiesToolDescriptions = JSON5.parse(
  fs.readFileSync(path.join(__dirname, 'tools.jsonc'), 'utf-8'),
);
