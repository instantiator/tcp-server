import * as fs from 'fs';
import * as path from 'path';
import JSON5 from 'json5';

/** Prompts and fixed strings for the lcp-agent service. */
export interface AgentPrompts {
  /** Closing directive appended after all context (prompt part 8). */
  final_instruction: string;
  /** Heading for the available-services section (prompt part 3). */
  services_header: string;
  /** Body text introducing the service list (prompt part 3). */
  services_intro: string;
  /** Per-service bullet template; `{{name}}` is replaced with the server name (prompt part 3). */
  services_item: string;
  /** Introductory sentence before RAG excerpts (prompt part 5). */
  rag_intro: string;
  /** Per-chunk heading template; `{{documentPath}}` is replaced with the source path (prompt part 5). */
  rag_source_header: string;
}

/** Loaded once at module initialisation from the co-located {@link prompts.jsonc} file. */
export const agentPrompts: AgentPrompts = JSON5.parse(
  fs.readFileSync(path.join(__dirname, 'prompts.jsonc'), 'utf-8'),
);
