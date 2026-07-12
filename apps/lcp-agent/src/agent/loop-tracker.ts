/** Structured record of storage operations performed during an agent loop run. */
export interface StorageChanges {
  created: string[];
  modified: string[];
  deleted: string[];
  moved: { from: string; to: string }[];
}

/** In-memory accumulator for actions and storage changes during a single loop run. */
export interface AgentLoopTracker {
  /** Human-readable action strings in chronological order, one per tool call. */
  actions: string[];
  /** Files created, modified, deleted, or moved during the run. */
  storage: StorageChanges;
  /** Base (unprefixed) names of every tool invoked during the run. */
  firedTools: Set<string>;
}

/** Creates an empty tracker for a new loop run. */
export function createTracker(): AgentLoopTracker {
  return {
    actions: [],
    storage: { created: [], modified: [], deleted: [], moved: [] },
    firedTools: new Set(),
  };
}

/** Strips the MCP server prefix from a tool name (e.g. `storage__write_file` → `write_file`). */
export function baseToolName(toolName: string): string {
  return toolName.includes('__')
    ? toolName.split('__').slice(1).join('__')
    : toolName;
}

/**
 * Generates a human-readable action string for a tool call.
 *
 * @param toolName - The full tool name (possibly prefixed, e.g. `storage__write_file`)
 * @param input - The tool input arguments from the `on_tool_start` event
 */
export function generateActionString(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const base = baseToolName(toolName);

  const s = (v: unknown): string =>
    typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';

  switch (base) {
    case 'write_file':
      return `Wrote file: ${s(input.path)}`;
    case 'delete_file':
      return `Deleted file: ${s(input.path)}`;
    case 'move_file':
      return `Moved file: ${s(input.source)} → ${s(input.destination)}`;
    case 'copy_file':
      return `Copied file: ${s(input.source)} → ${s(input.destination)}`;
    case 'restore_file':
      return `Restored file: ${s(input.path)}`;
    case 'read_file':
      return `Read file: ${s(input.path)}`;
    case 'list_files':
      return `Listed files`;
    case 'search_files':
      return `Searched files`;
    case 'recall':
      return `Recalled memory: ${s(input.query)}`;
    case 'remember':
      return `Stored memory`;
    case 'search_knowledge':
      return `Searched knowledge base`;
    case 'request_user_input':
      return `Requested user input: ${s(input.question)}`;
    case 'request_agent_consultation':
      // roleName is an optional label — roleId is always present and is the
      // actual lookup key, so fall back to it if no name was given.
      return `Consulted role '${s(input.roleName) || s(input.roleId)}': ${s(input.question)}`;
    case 'create_plan':
      return `Submitted task plan`;
    case 'complete_assignment':
      return `Submitted assignment completion`;
    case 'assure_assignment':
      return `Submitted QA verdict: ${s(input.qa)}`;
    default:
      return `Called tool: ${toolName}`;
  }
}

/** Tool names (base, without server prefix) whose successful results affect storage. */
const STORAGE_MUTATION_TOOLS = new Set([
  'write_file',
  'delete_file',
  'move_file',
  'copy_file',
  'restore_file',
]);

/**
 * Extracts the plain-text content from a LangGraph `on_tool_end` output.
 * Handles both string content and `{ type: 'text', text: string }[]` arrays.
 *
 * ponytail: uses duck-typing rather than importing LangChain ToolMessage to
 * avoid pulling the full message class into the tracker module
 */
function extractResultText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object') {
    const o = output as Record<string, unknown>;
    if (typeof o['content'] === 'string') return o['content'];
    if (Array.isArray(o['content'])) {
      const first = o['content'][0] as Record<string, unknown> | undefined;
      if (first && typeof first['text'] === 'string') return first['text'];
    }
  }
  return '';
}

/**
 * Updates the storage-change tracker based on a successful storage tool result.
 * Call this on every `on_tool_end` event; non-storage tools are ignored.
 *
 * @param toolName - Full tool name from the event
 * @param input - Input args captured at `on_tool_start` for this run_id
 * @param output - Raw output from the `on_tool_end` event data
 * @param tracker - Mutable tracker to update in place
 */
export function applyStorageResult(
  toolName: string,
  input: Record<string, unknown>,
  output: unknown,
  tracker: AgentLoopTracker,
): void {
  const base = baseToolName(toolName);

  if (!STORAGE_MUTATION_TOOLS.has(base)) return;

  const text = extractResultText(output);
  const s = (v: unknown): string =>
    typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';

  if (base === 'write_file' && text.startsWith('Written:')) {
    const path = s(input.path);
    if (input.overwrite === true) tracker.storage.modified.push(path);
    else tracker.storage.created.push(path);
  } else if (base === 'delete_file' && text.startsWith('Deleted:')) {
    tracker.storage.deleted.push(s(input.path));
  } else if (base === 'move_file' && text.startsWith('Moved:')) {
    tracker.storage.moved.push({
      from: s(input.source),
      to: s(input.destination),
    });
  } else if (base === 'copy_file' && text.startsWith('Copied:')) {
    tracker.storage.created.push(s(input.destination));
  } else if (base === 'restore_file' && text.startsWith('Restored:')) {
    tracker.storage.created.push(s(input.path));
  }
}
