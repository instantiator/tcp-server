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
  /** Per-service bullet template; `{{name}}` and `{{usage}}` are substituted (prompt part 3). */
  services_item: string;
  /** Bullet template for a server with no known {@link MCP_REGISTRY} usage text; `{{name}}` is substituted (prompt part 3). */
  services_item_unknown: string;
  /** Introductory sentence before RAG excerpts (prompt part 5). */
  rag_intro: string;
  /** Per-chunk heading template; `{{documentPath}}` is replaced with the source path (prompt part 5). */
  rag_source_header: string;
  /** LLM prompt requesting a completion summary; `{{initialPrompt}}`, `{{actionLines}}`, `{{created}}`, `{{modified}}`, `{{deleted}}`, `{{moved}}` are substituted. */
  completion_summary_prompt: string;
  /** Placeholder used in {@link completion_summary_prompt} when no actions were recorded. */
  completion_summary_no_actions: string;
  /** Placeholder used in {@link completion_summary_prompt} when no storage changes were recorded. */
  completion_summary_no_storage: string;
  /** Structured fallback summary template used when the LLM call fails; `{{taskSnippet}}`, `{{actionsSummary}}`, `{{storageSummary}}` are substituted. */
  completion_fallback_summary: string;
  /** Fragment used in {@link completion_fallback_summary} when actions were taken; `{{count}}` is substituted. */
  completion_fallback_actions: string;
  /** Fragment used in {@link completion_fallback_summary} when no actions were taken. */
  completion_fallback_no_actions: string;
  /** Fragment used in {@link completion_fallback_summary} when storage changed; `{{count}}` is substituted. */
  completion_fallback_storage: string;
  /** Fragment used in {@link completion_fallback_summary} when no storage changed. */
  completion_fallback_no_storage: string;
}

/** Loaded once at module initialisation from the co-located {@link prompts.jsonc} file. */
export const agentPrompts: AgentPrompts = JSON5.parse(
  fs.readFileSync(path.join(__dirname, 'prompts.jsonc'), 'utf-8'),
);
