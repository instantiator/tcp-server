import type { TcpAssignmentMode } from '../models/TcpAssignment.model';
import { MCP_REGISTRY } from '../mcp/mcp-registry';

/** A registered MCP server name (`'tasks' | 'storage' | 'memory' | 'interactions' | 'utilities' | 'records'`). */
export type McpServerName = (typeof MCP_REGISTRY)[number]['name'];

/**
 * The mutating storage tools — the ones a `read-only` storage scope withholds.
 * The single source of truth for both the client-side tool filter
 * ({@link filterToolsForMode}) and the read-only inspect-tools message the
 * storage service builds by inverting this set.
 */
export const STORAGE_WRITE_TOOLS: readonly string[] = [
  'create_working_file',
  'append_working_file',
  'replace_in_working_file',
  'rename_working_file',
  'delete_working_file',
  'restore_working_file',
];

/**
 * The records server's mutating tools, withheld from the read-only modes.
 * ponytail: filtered on the agent side only. Company scoping is the records
 * server's security boundary; this only keeps planners and reviewers from
 * changing records. Add a server-side check if an agent is seen bypassing it.
 */
export const RECORDS_WRITE_TOOLS: readonly string[] = [
  'create_table',
  'insert',
  'update',
  'delete',
];

/**
 * The storage server's resource-changing tools, withheld where resources are
 * read-only. Enforced on both sides, like the working-file tools: hidden here,
 * and refused by the storage server when the agent's scope has no write folder.
 */
export const RESOURCE_WRITE_TOOLS: readonly string[] = [
  'write_resource',
  'append_resource',
  'replace_in_resource',
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
  /** Records tools offered: all of them, or only the reads ({@link RECORDS_WRITE_TOOLS} dropped). */
  records: 'read-write' | 'read-only';
  /**
   * Company resource tools offered: all of them, or only the reads
   * ({@link RESOURCE_WRITE_TOOLS} dropped). Also decides whether the storage
   * scope gets a resource write folder.
   */
  resources: 'read-write' | 'read-only';
  /**
   * Whether the mode is offered `fail_assignment`. Chat has no assignment to
   * give up on, and a consultee answers a question rather than owning work.
   */
  canFail: boolean;
}

/**
 * The positive, per-mode tool profile — the single source of truth for which
 * MCP servers and storage tools each mode gets. Stated as an allowlist (rather
 * than a denylist) so a new developer can read off exactly what a mode can do.
 *
 * Notable restrictions: `plan` drops the `interactions` server entirely (no
 * consultation / user queries — removes every pause vector so planning always
 * terminates) and is storage read-only (it plans, it doesn't do the work); `qa`
 * is storage read-only (it reviews, it doesn't edit). Company resources are
 * also read-only to `consultee`: it advises another agent, it doesn't change
 * company documents.
 */
export const MODE_TOOLS: Record<TcpAssignmentMode, ModeToolAccess> = {
  plan: {
    servers: ['tasks', 'storage', 'memory', 'utilities', 'records'],
    storage: 'read-only',
    records: 'read-only',
    resources: 'read-only',
    canFail: true,
  },
  implement: {
    servers: [
      'tasks',
      'storage',
      'memory',
      'interactions',
      'utilities',
      'records',
    ],
    storage: 'read-write',
    records: 'read-write',
    resources: 'read-write',
    canFail: true,
  },
  qa: {
    servers: [
      'tasks',
      'storage',
      'memory',
      'interactions',
      'utilities',
      'records',
    ],
    storage: 'read-only',
    records: 'read-only',
    resources: 'read-only',
    canFail: true,
  },
  chat: {
    servers: [
      'tasks',
      'storage',
      'memory',
      'interactions',
      'utilities',
      'records',
    ],
    storage: 'read-write',
    records: 'read-write',
    resources: 'read-write',
    canFail: false,
  },
  consultee: {
    servers: [
      'tasks',
      'storage',
      'memory',
      'interactions',
      'utilities',
      'records',
    ],
    storage: 'read-write',
    records: 'read-write',
    resources: 'read-only',
    canFail: false,
  },
  finalise: {
    servers: [
      'tasks',
      'storage',
      'memory',
      'interactions',
      'utilities',
      'records',
    ],
    storage: 'read-write',
    records: 'read-write',
    resources: 'read-write',
    canFail: true,
  },
};

/** Whether `mode` may change company resources (server-side enforcement). */
export function canWriteResources(mode: TcpAssignmentMode): boolean {
  return MODE_TOOLS[mode].resources === 'read-write';
}

/** Whether the storage scope for `mode` is read-only (server-side enforcement). */
export function isStorageReadOnly(mode: TcpAssignmentMode): boolean {
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
  mode: TcpAssignmentMode,
): string[] {
  const allowed = new Set<string>(MODE_TOOLS[mode].servers);
  return serverNames.filter((name) => allowed.has(name));
}

/**
 * Filters already-loaded tools to those a mode is offered: only servers in
 * {@link MODE_TOOLS} `.servers`, and — for a `read-only` storage, records or
 * resources mode — with the mutating {@link STORAGE_WRITE_TOOLS},
 * {@link RECORDS_WRITE_TOOLS} or {@link RESOURCE_WRITE_TOOLS} dropped, and
 * `fail_assignment` dropped where `canFail` is false. Generic over the loaded-tool
 * shape so both the shared `McpTool` and any test double satisfy it.
 */
export function filterToolsForMode<
  T extends { serverName: string; toolName: string },
>(tools: T[], mode: TcpAssignmentMode): T[] {
  const allowedServers = new Set<string>(MODE_TOOLS[mode].servers);
  const dropWrites = MODE_TOOLS[mode].storage === 'read-only';
  const writeTools = new Set(STORAGE_WRITE_TOOLS);
  const dropRecordWrites = MODE_TOOLS[mode].records === 'read-only';
  const recordWriteTools = new Set(RECORDS_WRITE_TOOLS);
  const dropResourceWrites = MODE_TOOLS[mode].resources === 'read-only';
  const resourceWriteTools = new Set(RESOURCE_WRITE_TOOLS);
  const { canFail } = MODE_TOOLS[mode];
  return tools.filter((t) => {
    const name = stripServerPrefix(t.toolName);
    return (
      allowedServers.has(t.serverName) &&
      !(!canFail && t.serverName === 'tasks' && name === 'fail_assignment') &&
      !(dropWrites && writeTools.has(name)) &&
      !(
        dropRecordWrites &&
        t.serverName === 'records' &&
        recordWriteTools.has(name)
      ) &&
      !(
        dropResourceWrites &&
        t.serverName === 'storage' &&
        resourceWriteTools.has(name)
      )
    );
  });
}
