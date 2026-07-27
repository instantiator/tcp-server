import {
  filterToolsForMode,
  serverNamesForMode,
  isStorageReadOnly,
  MODE_TOOLS,
  STORAGE_WRITE_TOOLS,
} from './mode-tools';
import type { TcpAssignmentMode } from '../models/TcpAssignment.model';

const tool = (serverName: string, base: string) => ({
  serverName,
  toolName: `${serverName}__${base}`,
});

const FULL_SET = [
  tool('tasks', 'create_plan'),
  tool('storage', 'read_working_file'),
  tool('storage', 'list_working_files'),
  tool('storage', 'append_working_file'),
  tool('storage', 'replace_in_working_file'),
  tool('storage', 'rename_working_file'),
  tool('storage', 'delete_working_file'),
  tool('storage', 'restore_working_file'),
  tool('memory', 'search_knowledge'),
  tool('interactions', 'request_agent_consultation'),
];

const ALL_MODES: TcpAssignmentMode[] = [
  'plan',
  'implement',
  'qa',
  'chat',
  'consultee',
  'finalise',
];

describe('MODE_TOOLS', () => {
  it('covers every mode', () => {
    for (const mode of ALL_MODES) expect(MODE_TOOLS[mode]).toBeDefined();
  });

  it('makes only plan and qa storage read-only; plan alone drops interactions', () => {
    expect(isStorageReadOnly('plan')).toBe(true);
    expect(isStorageReadOnly('qa')).toBe(true);
    for (const mode of [
      'implement',
      'chat',
      'consultee',
      'finalise',
    ] as const) {
      expect(isStorageReadOnly(mode)).toBe(false);
    }
    expect(MODE_TOOLS.plan.servers).not.toContain('interactions');
    for (const mode of [
      'implement',
      'qa',
      'chat',
      'consultee',
      'finalise',
    ] as const) {
      expect(MODE_TOOLS[mode].servers).toContain('interactions');
    }
  });
});

describe('serverNamesForMode', () => {
  const names = ['tasks', 'storage', 'memory', 'interactions'];
  it('drops interactions for plan; keeps all servers for every other mode', () => {
    expect(serverNamesForMode(names, 'plan')).toEqual([
      'tasks',
      'storage',
      'memory',
    ]);
    for (const mode of [
      'implement',
      'qa',
      'chat',
      'consultee',
      'finalise',
    ] as const) {
      expect(serverNamesForMode(names, mode)).toEqual(names);
    }
  });
});

describe('filterToolsForMode', () => {
  it('plan: drops interactions and all storage write tools, keeps reads + tasks', () => {
    const kept = filterToolsForMode(FULL_SET, 'plan').map((t) => t.toolName);
    expect(kept).toContain('tasks__create_plan');
    expect(kept).toContain('storage__read_working_file');
    expect(kept).toContain('memory__search_knowledge');
    expect(kept).not.toContain('interactions__request_agent_consultation');
    for (const w of STORAGE_WRITE_TOOLS) {
      expect(kept).not.toContain(`storage__${w}`);
    }
  });

  it('qa: keeps interactions but drops storage write tools (read-only review)', () => {
    const kept = filterToolsForMode(FULL_SET, 'qa').map((t) => t.toolName);
    expect(kept).toContain('interactions__request_agent_consultation');
    expect(kept).toContain('storage__read_working_file');
    for (const w of STORAGE_WRITE_TOOLS) {
      expect(kept).not.toContain(`storage__${w}`);
    }
  });

  it('read-write modes keep the full set', () => {
    for (const mode of [
      'implement',
      'chat',
      'consultee',
      'finalise',
    ] as const) {
      expect(filterToolsForMode(FULL_SET, mode)).toHaveLength(FULL_SET.length);
    }
  });

  it('handles unprefixed tool names', () => {
    const bare = [{ serverName: 'storage', toolName: 'append_working_file' }];
    expect(filterToolsForMode(bare, 'plan')).toHaveLength(0);
  });
});
