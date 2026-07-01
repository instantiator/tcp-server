import {
  AgentLoopTracker,
  applyStorageResult,
  createTracker,
  generateActionString,
} from './loop-tracker';

describe('createTracker', () => {
  it('returns empty arrays', () => {
    const t = createTracker();
    expect(t.actions).toEqual([]);
    expect(t.storage.created).toEqual([]);
    expect(t.storage.modified).toEqual([]);
    expect(t.storage.deleted).toEqual([]);
    expect(t.storage.moved).toEqual([]);
  });
});

describe('generateActionString', () => {
  it('strips server prefix from tool name', () => {
    expect(
      generateActionString('storage__write_file', { path: 'foo/bar.md' }),
    ).toBe('Wrote file: foo/bar.md');
  });

  it('handles write_file', () => {
    expect(generateActionString('write_file', { path: 'doc.md' })).toBe(
      'Wrote file: doc.md',
    );
  });

  it('handles delete_file', () => {
    expect(
      generateActionString('storage__delete_file', { path: 'old.md' }),
    ).toBe('Deleted file: old.md');
  });

  it('handles move_file', () => {
    expect(
      generateActionString('storage__move_file', {
        source: 'a.md',
        destination: 'b.md',
      }),
    ).toBe('Moved file: a.md → b.md');
  });

  it('handles copy_file', () => {
    expect(
      generateActionString('storage__copy_file', {
        source: 'src.md',
        destination: 'dst.md',
      }),
    ).toBe('Copied file: src.md → dst.md');
  });

  it('handles restore_file', () => {
    expect(
      generateActionString('storage__restore_file', { path: 'doc.md' }),
    ).toBe('Restored file: doc.md');
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

  it('handles complete_task', () => {
    expect(generateActionString('interactions__complete_task', {})).toBe(
      'Submitted task completion',
    );
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

  describe('write_file', () => {
    it('adds to created when overwrite is false', () => {
      applyStorageResult(
        'storage__write_file',
        { path: 'new.md', overwrite: false },
        { content: 'Written: new.md' },
        tracker,
      );
      expect(tracker.storage.created).toEqual(['new.md']);
      expect(tracker.storage.modified).toEqual([]);
    });

    it('adds to modified when overwrite is true', () => {
      applyStorageResult(
        'storage__write_file',
        { path: 'existing.md', overwrite: true },
        { content: 'Written: existing.md' },
        tracker,
      );
      expect(tracker.storage.modified).toEqual(['existing.md']);
      expect(tracker.storage.created).toEqual([]);
    });

    it('defaults to created when overwrite is absent', () => {
      applyStorageResult(
        'storage__write_file',
        { path: 'doc.md' },
        { content: 'Written: doc.md' },
        tracker,
      );
      expect(tracker.storage.created).toEqual(['doc.md']);
    });

    it('ignores write_file when result does not start with Written:', () => {
      applyStorageResult(
        'storage__write_file',
        { path: 'bad.md' },
        { content: 'File already exists at bad.md.' },
        tracker,
      );
      expect(tracker.storage.created).toEqual([]);
    });
  });

  it('tracks delete_file on success', () => {
    applyStorageResult(
      'storage__delete_file',
      { path: 'gone.md' },
      { content: 'Deleted: gone.md (restorable via restore_file)' },
      tracker,
    );
    expect(tracker.storage.deleted).toEqual(['gone.md']);
  });

  it('ignores delete_file on failure', () => {
    applyStorageResult(
      'storage__delete_file',
      { path: 'missing.md' },
      { content: 'File not found: missing.md' },
      tracker,
    );
    expect(tracker.storage.deleted).toEqual([]);
  });

  it('tracks move_file on success', () => {
    applyStorageResult(
      'storage__move_file',
      { source: 'a.md', destination: 'b.md' },
      { content: 'Moved: a.md → b.md' },
      tracker,
    );
    expect(tracker.storage.moved).toEqual([{ from: 'a.md', to: 'b.md' }]);
  });

  it('tracks copy_file on success (destination added to created)', () => {
    applyStorageResult(
      'storage__copy_file',
      { source: 'template.md', destination: 'copy.md' },
      { content: 'Copied: template.md → copy.md' },
      tracker,
    );
    expect(tracker.storage.created).toEqual(['copy.md']);
  });

  it('tracks restore_file on success (added to created)', () => {
    applyStorageResult(
      'storage__restore_file',
      { path: 'recovered.md' },
      { content: 'Restored: recovered.md' },
      tracker,
    );
    expect(tracker.storage.created).toEqual(['recovered.md']);
  });

  it('handles plain string output', () => {
    applyStorageResult(
      'storage__write_file',
      { path: 'x.md' },
      'Written: x.md',
      tracker,
    );
    expect(tracker.storage.created).toEqual(['x.md']);
  });

  it('handles array content output', () => {
    applyStorageResult(
      'storage__write_file',
      { path: 'y.md' },
      { content: [{ type: 'text', text: 'Written: y.md' }] },
      tracker,
    );
    expect(tracker.storage.created).toEqual(['y.md']);
  });
});
