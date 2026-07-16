import type { TaskChangeSummary } from '@lcp/shared';
import {
  dateTimeSeconds,
  escapeMarkup,
  formatTaskState,
  makeRoleEntry,
  makeTaskEntry,
  PaneEntryLog,
  renderMultiListPanel,
  renderPaneHeading,
  renderRosterHeading,
  renderTaskListEntry,
  truncateWithEllipsis,
  wrapText,
} from './tui-format';
import type { SelectableList } from './tui-state';

function taskSummary(
  overrides: Partial<TaskChangeSummary> = {},
): TaskChangeSummary {
  return {
    id: 't1',
    status: 'ready',
    request: 'Write a short story about a cat.',
    createdAt: '2026-07-03T10:00:00.000Z',
    updatedAt: '2026-07-03T10:00:00.000Z',
    completedSteps: 0,
    totalSteps: 0,
    ...overrides,
  };
}

describe('escapeMarkup', () => {
  it('doubles a literal caret so terminal-kit displays it as-is', () => {
    expect(escapeMarkup('x^2')).toBe('x^^2');
  });

  it('leaves text with no caret unchanged', () => {
    expect(escapeMarkup('plain text')).toBe('plain text');
  });

  it('escapes every caret in a string with several', () => {
    expect(escapeMarkup('^^a^b^')).toBe('^^^^a^^b^^');
  });
});

describe('wrapText', () => {
  it('packs words onto lines up to the given width', () => {
    expect(wrapText('the quick brown fox jumps', 10)).toEqual([
      'the quick',
      'brown fox',
      'jumps',
    ]);
  });

  it('keeps a single overlong word on its own line', () => {
    expect(wrapText('supercalifragilisticexpialidocious', 10)).toEqual([
      'supercalifragilisticexpialidocious',
    ]);
  });

  it('treats embedded newlines as hard breaks', () => {
    expect(wrapText('line one\nline two', 20)).toEqual([
      'line one',
      'line two',
    ]);
  });

  it('strips trailing linebreaks', () => {
    expect(wrapText('done\n\n\n', 20)).toEqual(['done']);
  });

  it('returns a single empty line for empty text', () => {
    expect(wrapText('', 20)).toEqual(['']);
  });
});

describe('PaneEntryLog', () => {
  const ts = (s: string) => `2026-07-03T10:00:${s}.000Z`;
  // clockTime() renders in the test runner's local timezone, so derive the
  // expected hh:mm:ss the same way rather than hardcoding a UTC-relative string.
  const clock = (s: string) => new Date(ts(s)).toTimeString().slice(0, 8);

  it('formats a discrete agent_status event with the 3-column layout', () => {
    const log = new PaneEntryLog(false);
    log.append({
      kind: 'agent_status',
      timestamp: ts('01'),
      data: { status: 'running' },
    });
    expect(log.render(80)).toEqual([`${clock('01')} | agent_status | running`]);
  });

  it('includes the reason when present', () => {
    const log = new PaneEntryLog(false);
    log.append({
      kind: 'agent_status',
      timestamp: ts('01'),
      data: { status: 'running', reason: 'resumed' },
    });
    expect(log.render(80)).toEqual([
      `${clock('01')} | agent_status | running (resumed)`,
    ]);
  });

  it('formats an llm tool event with the tool name', () => {
    const log = new PaneEntryLog(false);
    log.append({
      kind: 'llm',
      timestamp: ts('02'),
      data: { activity: 'tool_started', tool: 'storage__list_files' },
    });
    expect(log.render(80)).toEqual([
      `${clock('02')} | llm | tool_started: storage__list_files`,
    ]);
  });

  it('formats consultation_started with the role name', () => {
    const log = new PaneEntryLog(false);
    log.append({
      kind: 'consultation_started',
      timestamp: ts('03'),
      data: { agentId: 'x', roleName: 'cat-assistant' },
    });
    expect(log.render(80)).toEqual([
      `${clock('03')} | consultation_started | consulting cat-assistant`,
    ]);
  });

  it('formats compaction_started and compaction_complete', () => {
    const log = new PaneEntryLog(false);
    log.append({
      kind: 'compaction_started',
      timestamp: ts('04'),
      data: {
        strategies: ['trim'],
        tokensBefore: 900,
        windowSize: 1000,
        pct: 90,
      },
    });
    log.append({
      kind: 'compaction_complete',
      timestamp: ts('05'),
      data: { tokensAfter: 400, windowSize: 1000, pctAfter: 40 },
    });
    expect(log.render(100)).toEqual([
      `${clock('04')} | compaction_started | compacting: strategies=[trim], 900/1000 tokens (90%)`,
      '',
      `${clock('05')} | compaction_complete | compacted: 400/1000 tokens (40%)`,
    ]);
  });

  it('renders reasoning deltas indented, without columns, in grey markup', () => {
    const log = new PaneEntryLog(false);
    log.append({
      kind: 'reasoning',
      timestamp: ts('06'),
      data: { delta: 'thinking' },
    });
    expect(log.render(80)).toEqual(['^K  thinking^:']);
  });

  it('escapes a literal caret in reasoning text so it survives markup rendering', () => {
    const log = new PaneEntryLog(false);
    log.append({
      kind: 'reasoning',
      timestamp: ts('06'),
      data: { delta: 'x^2 + y^2' },
    });
    expect(log.render(80)).toEqual(['^K  x^^2 + y^^2^:']);
  });

  it('escapes a literal caret in discrete/response text too', () => {
    const log = new PaneEntryLog(false);
    log.append({
      kind: 'agent_status',
      timestamp: ts('01'),
      data: { status: 'x^2' },
    });
    expect(log.render(80)).toEqual([`${clock('01')} | agent_status | x^^2`]);
  });

  it('suppresses reasoning entirely when hideReasoning is set', () => {
    const log = new PaneEntryLog(true);
    log.append({
      kind: 'reasoning',
      timestamp: ts('06'),
      data: { delta: 'thinking' },
    });
    expect(log.render(80)).toEqual([]);
  });

  it('merges consecutive reasoning deltas into one entry with no blank line between', () => {
    const log = new PaneEntryLog(false);
    log.append({
      kind: 'reasoning',
      timestamp: ts('06'),
      data: { delta: 'a' },
    });
    log.append({
      kind: 'reasoning',
      timestamp: ts('07'),
      data: { delta: 'b' },
    });
    expect(log.render(80)).toEqual(['^K  ab^:']);
  });

  it('merges consecutive response deltas into one entry, printing the header once', () => {
    const log = new PaneEntryLog(false);
    log.append({
      kind: 'response',
      timestamp: ts('08'),
      data: { delta: 'Hello' },
    });
    log.append({
      kind: 'response',
      timestamp: ts('09'),
      data: { delta: ' world' },
    });
    expect(log.render(80)).toEqual([`${clock('08')} | response | Hello world`]);
  });

  it('inserts a blank line when a discrete event interrupts an in-progress reasoning block', () => {
    const log = new PaneEntryLog(false);
    log.append({
      kind: 'reasoning',
      timestamp: ts('06'),
      data: { delta: 'thinking' },
    });
    log.append({
      kind: 'llm',
      timestamp: ts('07'),
      data: { activity: 'tool_started', tool: 'x' },
    });
    expect(log.render(80)).toEqual([
      '^K  thinking^:',
      '',
      `${clock('07')} | llm | tool_started: x`,
    ]);
  });

  it('inserts a blank line when reasoning resumes after being interrupted', () => {
    const log = new PaneEntryLog(false);
    log.append({
      kind: 'reasoning',
      timestamp: ts('06'),
      data: { delta: 'first' },
    });
    log.append({
      kind: 'llm',
      timestamp: ts('07'),
      data: { activity: 'tool_started', tool: 'x' },
    });
    log.append({
      kind: 'reasoning',
      timestamp: ts('08'),
      data: { delta: 'second' },
    });
    expect(log.render(80)).toEqual([
      '^K  first^:',
      '',
      `${clock('07')} | llm | tool_started: x`,
      '',
      '^K  second^:',
    ]);
  });

  it('ignores terminal and unknown event kinds', () => {
    const log = new PaneEntryLog(false);
    log.append({
      kind: 'completed',
      timestamp: ts('09'),
      data: { response: 'done' },
    });
    log.append({ kind: 'unknown_kind', timestamp: ts('10') });
    expect(log.render(80)).toEqual([]);
  });

  it('word-wraps a long discrete event to the pane width, indenting continuation lines under the header', () => {
    const log = new PaneEntryLog(false);
    log.append({
      kind: 'agent_status',
      timestamp: ts('01'),
      data: {
        status: 'a fairly long status line that should wrap across rows',
      },
    });
    const lines = log.render(30);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0].startsWith(`${clock('01')} | agent_status | `)).toBe(true);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(30);
    }
  });

  it('falls back to the current time when timestamp is missing or invalid', () => {
    const log = new PaneEntryLog(false);
    log.append({ kind: 'agent_status', data: { status: 'running' } });
    const lines = log.render(80);
    expect(lines[0]).toMatch(/^\d{2}:\d{2}:\d{2} \| agent_status \| running$/);
  });
});

describe('renderRosterHeading', () => {
  it('renders a Slug/Id heading, a prompt, and a blank separator', () => {
    expect(renderRosterHeading('acme-corp', 'company-1')).toEqual([
      'Slug: acme-corp',
      'Id: company-1',
      '',
      'Please select a role to initiate a chat:',
      '',
    ]);
  });

  it('escapes a literal caret in the company slug/id', () => {
    const lines = renderRosterHeading('a^b', 'c^d');
    expect(lines[0]).toBe('Slug: a^^b');
    expect(lines[1]).toBe('Id: c^^d');
  });
});

describe('makeRoleEntry', () => {
  it('marks the selected row with an inverse ">" and leaves the rest unmarked', () => {
    const entry = makeRoleEntry({ id: 'r1', name: 'Cat assistant' });
    expect(entry.render(80, false)).toEqual(['  Cat assistant']);
    expect(entry.render(80, true)).toEqual(['^!>^: Cat assistant']);
  });

  it('escapes a literal caret in a role name', () => {
    const entry = makeRoleEntry({ id: 'r1', name: 'x^2 assistant' });
    expect(entry.render(80, true)).toEqual(['^!>^: x^^2 assistant']);
  });
});

describe('renderMultiListPanel', () => {
  it('renders each list title, group titles, and entries, blank-line separated between lists', () => {
    const lists: SelectableList[] = [
      {
        title: 'Roles',
        groups: [{ entries: [makeRoleEntry({ id: 'r1', name: 'Cat' })] }],
      },
      {
        title: 'Tasks',
        groups: [
          { title: 'Active', entries: [makeTaskEntry(taskSummary(), 4)] },
          { title: 'Completed / failed', entries: [] },
        ],
      },
    ];
    const { lines } = renderMultiListPanel(lists, undefined, 80);
    expect(lines).toEqual([
      '^+Roles^:',
      '  Cat',
      '',
      '^+Tasks^:',
      'Active',
      `  ${dateTimeSeconds(taskSummary().createdAt)} (ready) "${taskSummary().request}"`,
      'Completed / failed',
      '  (none)',
    ]);
  });

  it('reports the selected line index for the caller to scroll into view', () => {
    const lists: SelectableList[] = [
      {
        title: 'Roles',
        groups: [
          {
            entries: [
              makeRoleEntry({ id: 'r1', name: 'Cat' }),
              makeRoleEntry({ id: 'r2', name: 'Dog' }),
            ],
          },
        ],
      },
    ];
    const { lines, selectedLine } = renderMultiListPanel(
      lists,
      {
        listIndex: 0,
        groupIndex: 0,
        entryIndex: 1,
        entry: lists[0].groups[0].entries[1],
      },
      80,
    );
    expect(selectedLine).toBe(2);
    expect(lines[selectedLine]).toBe('^!>^: Dog');
  });

  it('returns selectedLine -1 when nothing is selected', () => {
    const { selectedLine } = renderMultiListPanel([], undefined, 80);
    expect(selectedLine).toBe(-1);
  });
});

describe('dateTimeSeconds', () => {
  it('formats an ISO timestamp as yyyy-MM-dd HH:mm:ss', () => {
    expect(dateTimeSeconds('2026-07-03T10:05:09.000Z')).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    );
  });

  it('falls back to the raw string for an invalid timestamp', () => {
    expect(dateTimeSeconds('not-a-date')).toBe('not-a-date');
  });
});

describe('truncateWithEllipsis', () => {
  it('leaves text that already fits unchanged', () => {
    expect(truncateWithEllipsis('short', 10)).toBe('short');
  });

  it('truncates and appends an ellipsis when text overflows', () => {
    expect(truncateWithEllipsis('a fairly long piece of text', 10)).toBe(
      'a fairly …',
    );
  });

  it('clamps to width 1 minimum', () => {
    expect(truncateWithEllipsis('hello', 0)).toBe('h');
  });
});

describe('formatTaskState', () => {
  it('shows a fraction for in-progress', () => {
    expect(
      formatTaskState(
        taskSummary({
          status: 'in-progress',
          completedSteps: 2,
          totalSteps: 3,
        }),
      ),
    ).toBe('in progress: 2/3');
  });

  it.each([
    'ready',
    'planning',
    'finalising',
    'succeeded',
    'failed',
    'cancelled',
  ])('shows the bare status for %s', (status) => {
    expect(formatTaskState(taskSummary({ status: status as never }))).toBe(
      status,
    );
  });
});

describe('renderTaskListEntry', () => {
  it('renders one truncated line when not selected', () => {
    const lines = renderTaskListEntry(taskSummary(), false, 30, 4);
    expect(lines).toHaveLength(1);
    expect(lines[0].length).toBeLessThanOrEqual(30);
    expect(lines[0].startsWith('  ')).toBe(true);
  });

  it('expands to word-wrapped lines (capped at maxLines) with blank spacing when selected', () => {
    const long = taskSummary({
      request:
        'A very long request that should word-wrap across several lines when the entry is highlighted and expanded for reading',
    });
    const lines = renderTaskListEntry(long, true, 20, 3);
    expect(lines[0]).toBe('');
    expect(lines[lines.length - 1]).toBe('');
    const body = lines.slice(1, -1);
    expect(body.length).toBeLessThanOrEqual(3);
    expect(body[0].startsWith('^!>^: ')).toBe(true);
  });
});

describe('renderPaneHeading', () => {
  it('renders a Name/Id heading followed by a blank separator line', () => {
    expect(renderPaneHeading('Cat assistant', 'role-1')).toEqual([
      'Name: Cat assistant',
      'Id: role-1',
      '',
    ]);
  });

  it('escapes a literal caret in the name/id', () => {
    expect(renderPaneHeading('x^2', 'id^y')).toEqual([
      'Name: x^^2',
      'Id: id^^y',
      '',
    ]);
  });
});
