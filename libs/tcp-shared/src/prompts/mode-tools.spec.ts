import {
  canWriteResources,
  filterToolsForMode,
  serverNamesForMode,
  isStorageReadOnly,
  MODE_TOOLS,
  RECORDS_WRITE_TOOLS,
  RESOURCE_WRITE_TOOLS,
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
  tool('records', 'query'),
  tool('records', 'aggregate'),
  tool('records', 'insert'),
  tool('records', 'update'),
  tool('records', 'delete'),
  tool('records', 'create_table'),
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

  it('offers utilities to every mode, since it only computes and never changes anything', () => {
    for (const mode of Object.keys(MODE_TOOLS) as (keyof typeof MODE_TOOLS)[]) {
      expect(MODE_TOOLS[mode].servers).toContain('utilities');
    }
  });
});

describe('serverNamesForMode', () => {
  const names = [
    'tasks',
    'storage',
    'memory',
    'interactions',
    'utilities',
    'records',
  ];
  it('drops interactions for plan; keeps all servers for every other mode', () => {
    expect(serverNamesForMode(names, 'plan')).toEqual([
      'tasks',
      'storage',
      'memory',
      'utilities',
      'records',
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

  it.each<[TcpAssignmentMode, boolean]>([
    ['plan', true],
    ['implement', true],
    ['qa', true],
    ['finalise', true],
    ['chat', false],
    ['consultee', false],
  ])('%s: offers fail_assignment = %s', (mode, offered) => {
    const kept = filterToolsForMode(
      [tool('tasks', 'fail_assignment')],
      mode,
    ).map((t) => t.toolName);
    expect(kept.includes('tasks__fail_assignment')).toBe(offered);
  });

  it('offers do_not_store even where records are read-only: adding to it only protects people', () => {
    for (const mode of ['plan', 'qa'] as const) {
      const kept = filterToolsForMode(
        [tool('records', 'do_not_store')],
        mode,
      ).map((t) => t.toolName);
      expect(kept).toEqual(['records__do_not_store']);
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

  it('plan and qa keep the records reads but drop every records write', () => {
    for (const mode of ['plan', 'qa'] as const) {
      const kept = filterToolsForMode(FULL_SET, mode).map((t) => t.toolName);
      expect(kept).toEqual(
        expect.arrayContaining(['records__query', 'records__aggregate']),
      );
      for (const w of RECORDS_WRITE_TOOLS) {
        expect(kept).not.toContain(`records__${w}`);
      }
    }
  });

  it('drops records write names only from the records server', () => {
    const other = [{ serverName: 'storage', toolName: 'storage__insert' }];
    expect(filterToolsForMode(other, 'plan')).toHaveLength(1);
  });

  describe('company resource tools', () => {
    const RESOURCE_SET = [
      tool('storage', 'list_resources'),
      tool('storage', 'read_resource'),
      ...RESOURCE_WRITE_TOOLS.map((w) => tool('storage', w)),
    ];

    it.each(['implement', 'chat', 'finalise'] as const)(
      '%s keeps every resource tool',
      (mode) => {
        expect(filterToolsForMode(RESOURCE_SET, mode)).toHaveLength(
          RESOURCE_SET.length,
        );
        expect(canWriteResources(mode)).toBe(true);
      },
    );

    it.each(['plan', 'qa', 'consultee'] as const)(
      '%s keeps the reads but drops every resource write',
      (mode) => {
        const kept = filterToolsForMode(RESOURCE_SET, mode).map(
          (t) => t.toolName,
        );
        expect(kept).toEqual([
          'storage__list_resources',
          'storage__read_resource',
        ]);
        expect(canWriteResources(mode)).toBe(false);
      },
    );

    it('keeps consultee working-file writes while dropping resource writes', () => {
      const kept = filterToolsForMode(FULL_SET, 'consultee');
      expect(kept).toHaveLength(FULL_SET.length);
    });
  });

  it('handles unprefixed tool names', () => {
    const bare = [{ serverName: 'storage', toolName: 'append_working_file' }];
    expect(filterToolsForMode(bare, 'plan')).toHaveLength(0);
  });
});
