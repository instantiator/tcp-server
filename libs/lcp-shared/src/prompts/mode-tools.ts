import type { LcpAssignmentMode } from '../models/LcpAssignment.model';

/**
 * Per-mode capability restriction: MCP servers whose tools an agent in the
 * given mode must not be offered at all. Dropping a whole server (rather than
 * naming each tool) is the right grain when *none* of a server's tools suit
 * the mode.
 *
 * Only `plan` is restricted today: a planner's single job is to call
 * `create_plan`, so it is denied the `interactions` server entirely — no agent
 * consultation and no user queries. That removes every pause vector from a
 * planning run, so the `create_plan` required-tool enforcement can always drive
 * the run to completion or a clean failure rather than wedging the task in
 * `planning` (see {@link requiredToolForMode}).
 */
export const MODE_DENIED_SERVERS: Partial<Record<LcpAssignmentMode, string[]>> =
  {
    plan: ['interactions'],
  };

/**
 * Per-mode capability restriction at the individual-tool grain, for servers a
 * mode otherwise keeps. A `plan` agent keeps the `storage` server for read-only
 * inspection of its materials, but is denied its mutating tools so it cannot
 * short-circuit into doing the work itself.
 */
export const MODE_DENIED_TOOLS: Partial<Record<LcpAssignmentMode, string[]>> = {
  plan: [
    'append_working_file',
    'replace_in_working_file',
    'delete_working_file',
    'restore_working_file',
  ],
};

/** Strips the `serverName__` prefix from a loaded tool name, if present. */
function stripServerPrefix(toolName: string): string {
  return toolName?.includes('__')
    ? toolName.split('__').slice(1).join('__')
    : toolName;
}

/**
 * Narrows an MCP server name list to those allowed for the given mode, dropping
 * any server in {@link MODE_DENIED_SERVERS}. Apply before loading tools so a
 * fully-denied server is never even contacted.
 */
export function serverNamesForMode(
  serverNames: string[],
  mode: LcpAssignmentMode,
): string[] {
  const denied = new Set(MODE_DENIED_SERVERS[mode] ?? []);
  return serverNames.filter((name) => !denied.has(name));
}

/**
 * Filters already-loaded tools to those allowed for the given mode, dropping
 * any whose server is denied ({@link MODE_DENIED_SERVERS}) or whose base tool
 * name is denied ({@link MODE_DENIED_TOOLS}). Generic over the loaded-tool
 * shape so both the shared `McpTool` and any test double satisfy it.
 */
export function filterToolsForMode<
  T extends { serverName: string; toolName: string },
>(tools: T[], mode: LcpAssignmentMode): T[] {
  const deniedServers = MODE_DENIED_SERVERS[mode] ?? [];
  const deniedTools = MODE_DENIED_TOOLS[mode] ?? [];
  // Unrestricted mode: leave the toolset (and each tool's fields) untouched.
  if (deniedServers.length === 0 && deniedTools.length === 0) return tools;

  const servers = new Set(deniedServers);
  const names = new Set(deniedTools);
  return tools.filter(
    (t) =>
      !servers.has(t.serverName) && !names.has(stripServerPrefix(t.toolName)),
  );
}
