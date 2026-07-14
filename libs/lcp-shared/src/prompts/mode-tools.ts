import type { LcpAssignmentMode } from '../models/LcpAssignment.model';
import { MCP_REGISTRY } from '../mcp/mcp-registry';

/** A registered MCP server name (`'tasks' | 'storage' | 'memory' | 'interactions'`). */
export type McpServerName = (typeof MCP_REGISTRY)[number]['name'];

/**
 * The mutating storage tools — the ones a `read-only` storage scope withholds.
 * The single source of truth for both the client-side tool filter
 * ({@link filterToolsForMode}) and the read-only inspect-tools message the
 * storage service builds by inverting this set.
 */
export const STORAGE_WRITE_TOOLS: readonly string[] = [
  'append_working_file',
  'replace_in_working_file',
  'rename_working_file',
  'delete_working_file',
  'restore_working_file',
];

/** What tools a given mode is offered. */
export interface ModeToolAccess {
  /** MCP servers offered to this mode. */
  servers: readonly McpServerName[];
  /**
   * Storage tools offered: `read-write` (mutating + read) or `read-only`
   * (read/list/search only). Drives both the client-side tool filter and the
   * server-side {@link resolveStorageScope} read-only flag, so the two can't
   * drift.
   */
  storage: 'read-write' | 'read-only';
}

/**
 * The positive, per-mode tool profile — the single source of truth for which
 * MCP servers and storage tools each mode gets. Stated as an allowlist (rather
 * than a denylist) so a new developer can read off exactly what a mode can do.
 *
 * Notable restrictions: `plan` drops the `interactions` server entirely (no
 * consultation / user queries — removes every pause vector so planning always
 * terminates) and is storage read-only (it plans, it doesn't do the work); `qa`
 * is storage read-only (it reviews, it doesn't edit).
 */
export const MODE_TOOLS: Record<LcpAssignmentMode, ModeToolAccess> = {
  plan: { servers: ['tasks', 'storage', 'memory'], storage: 'read-only' },
  implement: {
    servers: ['tasks', 'storage', 'memory', 'interactions'],
    storage: 'read-write',
  },
  qa: {
    servers: ['tasks', 'storage', 'memory', 'interactions'],
    storage: 'read-only',
  },
  chat: {
    servers: ['tasks', 'storage', 'memory', 'interactions'],
    storage: 'read-write',
  },
  consultee: {
    servers: ['tasks', 'storage', 'memory', 'interactions'],
    storage: 'read-write',
  },
  finalise: {
    servers: ['tasks', 'storage', 'memory', 'interactions'],
    storage: 'read-write',
  },
};

/** Whether the storage scope for `mode` is read-only (server-side enforcement). */
export function isStorageReadOnly(mode: LcpAssignmentMode): boolean {
  return MODE_TOOLS[mode].storage === 'read-only';
}

/** Strips the `serverName__` prefix from a loaded tool name, if present. */
function stripServerPrefix(toolName: string): string {
  return toolName?.includes('__')
    ? toolName.split('__').slice(1).join('__')
    : toolName;
}

/**
 * Narrows an MCP server name list to those a mode is offered ({@link MODE_TOOLS}
 * `.servers`). Apply before loading tools so a server the mode doesn't get is
 * never even contacted.
 */
export function serverNamesForMode(
  serverNames: string[],
  mode: LcpAssignmentMode,
): string[] {
  const allowed = new Set<string>(MODE_TOOLS[mode].servers);
  return serverNames.filter((name) => allowed.has(name));
}

/**
 * Filters already-loaded tools to those a mode is offered: only servers in
 * {@link MODE_TOOLS} `.servers`, and — for a `read-only` storage mode — with the
 * mutating {@link STORAGE_WRITE_TOOLS} dropped. Generic over the loaded-tool
 * shape so both the shared `McpTool` and any test double satisfy it.
 */
export function filterToolsForMode<
  T extends { serverName: string; toolName: string },
>(tools: T[], mode: LcpAssignmentMode): T[] {
  const allowedServers = new Set<string>(MODE_TOOLS[mode].servers);
  const dropWrites = MODE_TOOLS[mode].storage === 'read-only';
  const writeTools = new Set(STORAGE_WRITE_TOOLS);
  return tools.filter(
    (t) =>
      allowedServers.has(t.serverName) &&
      !(dropWrites && writeTools.has(stripServerPrefix(t.toolName))),
  );
}
