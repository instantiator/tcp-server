import * as fs from 'fs';
import * as path from 'path';
import JSON5 from 'json5';

/** Tool names and descriptions for the lcp-mcp-memory service. */
export interface MemoryToolDescriptions {
  describe_server: string;
  recall: string;
  remember: string;
  search_knowledge: string;
}

/** Loaded once at module initialisation from the co-located {@link tools.jsonc} file. */
export const memoryToolDescriptions: MemoryToolDescriptions = JSON5.parse(
  fs.readFileSync(path.join(__dirname, 'tools.jsonc'), 'utf-8'),
);
