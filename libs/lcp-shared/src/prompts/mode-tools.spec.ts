import {
  filterToolsForMode,
  serverNamesForMode,
  MODE_DENIED_SERVERS,
  MODE_DENIED_TOOLS,
} from './mode-tools';

const tool = (serverName: string, base: string) => ({
  serverName,
  toolName: `${serverName}__${base}`,
});

const FULL_SET = [
  tool('tasks', 'create_plan'),
  tool('tasks', 'describe_server'),
  tool('storage', 'read_working_file'),
  tool('storage', 'list_working_files'),
  tool('storage', 'append_working_file'),
  tool('storage', 'replace_in_working_file'),
  tool('storage', 'delete_working_file'),
  tool('storage', 'restore_working_file'),
  tool('memory', 'search_knowledge'),
  tool('interactions', 'request_agent_consultation'),
  tool('interactions', 'request_user_input'),
];

describe('serverNamesForMode', () => {
  it('drops the interactions server for plan mode only', () => {
    const names = ['tasks', 'storage', 'memory', 'interactions'];
    expect(serverNamesForMode(names, 'plan')).toEqual([
      'tasks',
      'storage',
      'memory',
    ]);
    for (const mode of ['implement', 'qa', 'chat'] as const) {
      expect(serverNamesForMode(names, mode)).toEqual(names);
    }
  });
});

describe('filterToolsForMode', () => {
  it('strips consultation, user-query and file-write tools from plan mode', () => {
    const kept = filterToolsForMode(FULL_SET, 'plan').map((t) => t.toolName);
    // create_plan + storage reads survive
    expect(kept).toContain('tasks__create_plan');
    expect(kept).toContain('storage__read_working_file');
    expect(kept).toContain('storage__list_working_files');
    expect(kept).toContain('memory__search_knowledge');
    // interactions server gone entirely
    expect(kept).not.toContain('interactions__request_agent_consultation');
    expect(kept).not.toContain('interactions__request_user_input');
    // storage mutators gone
    expect(kept).not.toContain('storage__append_working_file');
    expect(kept).not.toContain('storage__replace_in_working_file');
    expect(kept).not.toContain('storage__delete_working_file');
    expect(kept).not.toContain('storage__restore_working_file');
  });

  it('leaves other modes untouched', () => {
    for (const mode of ['implement', 'qa', 'chat'] as const) {
      expect(filterToolsForMode(FULL_SET, mode)).toHaveLength(FULL_SET.length);
    }
  });

  it('handles unprefixed tool names', () => {
    const bare = [{ serverName: 'storage', toolName: 'append_working_file' }];
    expect(filterToolsForMode(bare, 'plan')).toHaveLength(0);
  });
});

describe('restriction tables', () => {
  it('only restrict plan mode', () => {
    expect(Object.keys(MODE_DENIED_SERVERS)).toEqual(['plan']);
    expect(Object.keys(MODE_DENIED_TOOLS)).toEqual(['plan']);
  });
});
