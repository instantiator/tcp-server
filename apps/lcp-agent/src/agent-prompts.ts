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
  /** Reminder when required tool(s) were never invoked; `{{tools}}` is substituted. */
  required_tools_reminder: string;
  /** Reminder when required tool(s) were never invoked but a `<tool_call>` block was described in text; `{{tools}}` and `{{describedCall}}` are substituted. */
  required_tools_reminder_with_described_call: string;
  /** Reminder when required tool(s) were invoked but the call failed; `{{tools}}` is substituted. */
  required_tools_call_failed: string;
  /** Heading for the materials list in the assignment-presentation prompt part (part 4). */
  assignment_materials_header: string;
  /** Heading for the expected-outputs list in the assignment-presentation prompt part (part 4). */
  assignment_expected_header: string;
  /** Introductory sentence before RAG excerpts (prompt part 5). */
  rag_intro: string;
  /** Per-chunk heading template; `{{documentPath}}` is replaced with the source path (prompt part 5). */
  rag_source_header: string;
  /** Deterministic completion summary (no LLM call); `{{actionLines}}`, `{{created}}`, `{{modified}}`, `{{deleted}}`, `{{moved}}` are substituted. */
  completion_summary_deterministic: string;
  /** Placeholder used in {@link completion_summary_deterministic} when no actions were recorded. */
  completion_summary_no_actions: string;
  /** Placeholder used in {@link completion_summary_deterministic} when no storage changes were recorded. */
  completion_summary_no_storage: string;
}

/** Loaded once at module initialisation from the co-located {@link prompts.jsonc} file. */
export const agentPrompts: AgentPrompts = JSON5.parse(
  fs.readFileSync(path.join(__dirname, 'prompts.jsonc'), 'utf-8'),
);
