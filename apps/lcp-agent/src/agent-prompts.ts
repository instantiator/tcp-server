import * as fs from 'fs';
import * as path from 'path';
import JSON5 from 'json5';

/** Prompts and fixed strings for the lcp-agent service. */
export interface AgentPrompts {
  final_instruction: string;
}

/** Loaded once at module initialisation from the co-located {@link prompts.jsonc} file. */
export const agentPrompts: AgentPrompts = JSON5.parse(
  fs.readFileSync(path.join(__dirname, 'prompts.jsonc'), 'utf-8'),
);
