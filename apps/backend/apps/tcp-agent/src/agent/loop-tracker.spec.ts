import {
  AgentLoopTracker,
  applyStorageResult,
  baseToolName,
  createTracker,
  detectDescribedToolCall,
  extractChatModelText,
  generateActionString,
  noteToolCall,
} from './loop-tracker';

describe('createTracker', () => {
  it('returns empty arrays', () => {
    const t = createTracker();
    expect(t.actions).toEqual([]);
    expect(t.storage.created).toEqual([]);
    expect(t.storage.modified).toEqual([]);
    expect(t.storage.deleted).toEqual([]);
    expect(t.storage.moved).toEqual([]);
    expect(t.firedTools.size).toBe(0);
    expect(t.lastResponseText).toBe('');
  });
});

describe('extractChatModelText', () => {
  it('reads string content', () => {
    expect(extractChatModelText({ content: 'hello' })).toBe('hello');
  });

  it('reads content-block array text', () => {
    expect(
      extractChatModelText({
        content: [{ type: 'text', text: 'block one' }],
      }),
    ).toBe('block one');
  });

  it('returns empty string for non-object output', () => {
    expect(extractChatModelText(undefined)).toBe('');
    expect(extractChatModelText('plain string')).toBe('');
  });

  it('returns empty string when content is missing', () => {
    expect(extractChatModelText({})).toBe('');
  });
});

describe('detectDescribedToolCall', () => {
  it('finds a well-formed tool_call block', () => {
    const text =
      'Sure, here it is:\n<tool_call>{"name":"foo"}</tool_call>\ndone';
    expect(detectDescribedToolCall(text)).toBe('{"name":"foo"}');
  });

  it('is case-insensitive on the tag', () => {
    expect(detectDescribedToolCall('<TOOL_CALL>abc</TOOL_CALL>')).toBe('abc');
  });

  it('returns null when no tool_call tag is present', () => {
    expect(detectDescribedToolCall('just narration, no tags')).toBeNull();
  });

  it('returns null for an unclosed tag', () => {
    expect(detectDescribedToolCall('<tool_call>{"name":"foo"}')).toBeNull();
  });
});

describe('baseToolName', () => {
  it('strips the server prefix', () => {
    expect(baseToolName('interactions__complete_task')).toBe('complete_task');
  });

  it('preserves later double underscores', () => {
    expect(baseToolName('server__oddly__named')).toBe('oddly__named');
  });

  it('returns unprefixed names unchanged', () => {
    expect(baseToolName('complete_task')).toBe('complete_task');
  });
});

describe('generateActionString', () => {
  it('strips server prefix from tool name', () => {
    expect(
      generateActionString('storage__append_working_file', {
        filename: 'foo/bar.md',
      }),
    ).toBe('Appended to working file: foo/bar.md');
  });

  it('handles create_working_file', () => {
    expect(
      generateActionString('storage__create_working_file', {
        filename: 'doc.md',
      }),
    ).toBe('Created working file: doc.md');
  });

  it('handles append_working_file', () => {
    expect(
      generateActionString('append_working_file', { filename: 'doc.md' }),
    ).toBe('Appended to working file: doc.md');
  });

  it('handles replace_in_working_file', () => {
    expect(
      generateActionString('storage__replace_in_working_file', {
        filename: 'doc.md',
      }),
    ).toBe('Edited working file: doc.md');
  });

  it('handles delete_working_file', () => {
    expect(
      generateActionString('storage__delete_working_file', {
        filename: 'old.md',
      }),
    ).toBe('Deleted working file: old.md');
  });

  it('handles restore_working_file', () => {
    expect(
      generateActionString('storage__restore_working_file', {
        filename: 'doc.md',
      }),
    ).toBe('Restored working file: doc.md');
  });

  it('handles read_material_file', () => {
    expect(
      generateActionString('storage__read_material_file', {
        filename: 'brief.md',
      }),
    ).toBe('Read material: brief.md');
  });

  it('handles read_file', () => {
    expect(generateActionString('storage__read_file', { path: 'doc.md' })).toBe(
      'Read file: doc.md',
    );
  });

  it('handles recall', () => {
    expect(
      generateActionString('memory__recall', { query: 'prior decisions' }),
    ).toBe('Recalled memory: prior decisions');
  });

  it('handles remember', () => {
    expect(generateActionString('memory__remember', {})).toBe('Stored memory');
  });

  it('handles request_user_input', () => {
    expect(
      generateActionString('interactions__request_user_input', {
        question: 'Is this correct?',
      }),
    ).toBe('Requested user input: Is this correct?');
  });

  it('handles request_agent_consultation', () => {
    expect(
      generateActionString('interactions__request_agent_consultation', {
        roleName: 'analyst',
        question: 'Check this',
      }),
    ).toBe("Consulted role 'analyst': Check this");
  });

  it('falls back to roleId for request_agent_consultation when roleName is omitted', () => {
    expect(
      generateActionString('interactions__request_agent_consultation', {
        roleId: 'role-123',
        question: 'Check this',
      }),
    ).toBe("Consulted role 'role-123': Check this");
  });

  it('handles complete_assignment', () => {
    expect(generateActionString('tasks__complete_assignment', {})).toBe(
      'Submitted assignment completion',
    );
  });

  it('handles create_plan', () => {
    expect(generateActionString('tasks__create_plan', {})).toBe(
      'Submitted task plan',
    );
  });

  it('handles assure_assignment', () => {
    expect(
      generateActionString('tasks__assure_assignment', { qa: 'accept' }),
    ).toBe('Submitted QA verdict: accept');
  });

  it('falls back for unknown tools', () => {
    expect(generateActionString('storage__describe_server', {})).toBe(
      'Called tool: storage__describe_server',
    );
  });
});

describe('applyStorageResult', () => {
  let tracker: AgentLoopTracker;

  beforeEach(() => {
    tracker = createTracker();
  });

  it('ignores non-storage tools', () => {
    applyStorageResult(
      'interactions__complete_task',
      {},
      'Task complete.',
      tracker,
    );
    expect(tracker.storage).toEqual({
      created: [],
      modified: [],
      deleted: [],
      moved: [],
    });
  });

  describe('create_working_file', () => {
    it('adds to created when the file was created', () => {
      applyStorageResult(
        'storage__create_working_file',
        { filename: 'new.md' },
        { content: 'Created working file: new.md' },
        tracker,
      );
      expect(tracker.storage.created).toEqual(['new.md']);
      expect(tracker.storage.modified).toEqual([]);
    });

    it('adds to modified when the file was replaced', () => {
      applyStorageResult(
        'storage__create_working_file',
        { filename: 'existing.md' },
        { content: 'Replaced working file: existing.md' },
        tracker,
      );
      expect(tracker.storage.modified).toEqual(['existing.md']);
      expect(tracker.storage.created).toEqual([]);
    });

    it('ignores create_working_file on an error result', () => {
      applyStorageResult(
        'storage__create_working_file',
        { filename: 'bad.md' },
        {
          content:
            "'bad.md' already exists. Set overwrite: true to replace it.",
        },
        tracker,
      );
      expect(tracker.storage.created).toEqual([]);
      expect(tracker.storage.modified).toEqual([]);
    });
  });

  describe('append_working_file', () => {
    it('adds to created when the file was created', () => {
      applyStorageResult(
        'storage__append_working_file',
        { filename: 'new.md' },
        { content: 'Created working file: new.md' },
        tracker,
      );
      expect(tracker.storage.created).toEqual(['new.md']);
      expect(tracker.storage.modified).toEqual([]);
    });

    it('adds to modified when the file already existed', () => {
      applyStorageResult(
        'storage__append_working_file',
        { filename: 'existing.md' },
        { content: 'Appended to working file: existing.md' },
        tracker,
      );
      expect(tracker.storage.modified).toEqual(['existing.md']);
      expect(tracker.storage.created).toEqual([]);
    });

    it('ignores append_working_file on an error result', () => {
      applyStorageResult(
        'storage__append_working_file',
        { filename: 'bad.md' },
        { content: 'Fix the JSON syntax.' },
        tracker,
      );
      expect(tracker.storage.created).toEqual([]);
      expect(tracker.storage.modified).toEqual([]);
    });
  });

  it('tracks replace_in_working_file as modified', () => {
    applyStorageResult(
      'storage__replace_in_working_file',
      { filename: 'doc.md' },
      { content: 'Replaced 2 occurrence(s) in working file: doc.md' },
      tracker,
    );
    expect(tracker.storage.modified).toEqual(['doc.md']);
  });

  it('tracks delete_working_file on success', () => {
    applyStorageResult(
      'storage__delete_working_file',
      { filename: 'gone.md' },
      { content: 'Deleted working file: gone.md (restorable via ...)' },
      tracker,
    );
    expect(tracker.storage.deleted).toEqual(['gone.md']);
  });

  it('ignores delete_working_file on failure', () => {
    applyStorageResult(
      'storage__delete_working_file',
      { filename: 'missing.md' },
      { content: 'File not found: missing.md' },
      tracker,
    );
    expect(tracker.storage.deleted).toEqual([]);
  });

  it('tracks restore_working_file on success (added to created)', () => {
    applyStorageResult(
      'storage__restore_working_file',
      { filename: 'recovered.md' },
      { content: 'Restored working file: recovered.md' },
      tracker,
    );
    expect(tracker.storage.created).toEqual(['recovered.md']);
  });

  it('handles plain string output', () => {
    applyStorageResult(
      'storage__append_working_file',
      { filename: 'x.md' },
      'Created working file: x.md',
      tracker,
    );
    expect(tracker.storage.created).toEqual(['x.md']);
  });

  it('handles array content output', () => {
    applyStorageResult(
      'storage__append_working_file',
      { filename: 'y.md' },
      { content: [{ type: 'text', text: 'Created working file: y.md' }] },
      tracker,
    );
    expect(tracker.storage.created).toEqual(['y.md']);
  });
});

describe('noteToolCall', () => {
  const refused = { content: '2 values were not valid:\n- assignment 2 …' };

  it('flags the third identical call with an identical result', () => {
    const tracker = createTracker();
    expect(noteToolCall(tracker, 'tasks__create_plan', { a: 1 }, refused)).toBe(
      false,
    );
    expect(noteToolCall(tracker, 'tasks__create_plan', { a: 1 }, refused)).toBe(
      false,
    );
    expect(noteToolCall(tracker, 'tasks__create_plan', { a: 1 }, refused)).toBe(
      true,
    );
    expect(tracker.repeatedCall).toEqual({
      tool: 'create_plan',
      result: '2 values were not valid:',
    });
  });

  it.each([
    ['a changed input', { a: 2 }, refused],
    ['a changed result', { a: 1 }, { content: 'Plan created.' }],
  ])('starts counting again after %s', (_label, input, output) => {
    const tracker = createTracker();
    noteToolCall(tracker, 'tasks__create_plan', { a: 1 }, refused);
    noteToolCall(tracker, 'tasks__create_plan', { a: 1 }, refused);
    expect(noteToolCall(tracker, 'tasks__create_plan', input, output)).toBe(
      false,
    );
    expect(tracker.callRepeats).toBe(1);
  });
});
