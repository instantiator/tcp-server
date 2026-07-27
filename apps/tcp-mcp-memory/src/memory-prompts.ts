import * as fs from 'fs';
import * as path from 'path';
import JSON5 from 'json5';

/** Prompts and fixed strings for the tcp-mcp-memory service. */
export interface MemoryPrompts {
  describe_server: string;
  no_embedding_config: string;
  no_embedding_config_store: string;
  no_results: string;
  memory_stored: string;
}

/** Loaded once at module initialisation from the co-located {@link prompts.jsonc} file. */
export const memoryPrompts: MemoryPrompts = JSON5.parse(
  fs.readFileSync(path.join(__dirname, 'prompts.jsonc'), 'utf-8'),
);
