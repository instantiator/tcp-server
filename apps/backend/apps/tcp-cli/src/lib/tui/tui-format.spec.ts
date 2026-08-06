import type { TaskChangeSummary } from '@tcp/shared';
import {
  AssignmentRow,
  dateTimeSeconds,
  escapeMarkup,
  formatTaskState,
  makeAssignmentEntry,
  makeRoleEntry,
  makeTaskEntry,
  renderAssignmentListEntry,
  renderAssignmentPaneHeading,
  renderMultiListPanel,
  renderRosterHeading,
  renderTaskListEntry,
  renderTaskPaneHeading,
  statusColor,
  truncateWithEllipsis,
  wrapText,
} from './tui-format';
import type { SelectableList } from './tui-state';

function taskSummary(
  overrides: Partial<TaskChangeSummary> = {},
): TaskChangeSummary {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'ready',
    request: 'Write a short story about a cat.',
    shortcode: '000',
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
    const entry = makeRoleEntry({
      id: 'r1',
      name: 'Cat assistant',
      slug: 'cat-assistant',
    });
    expect(entry.render(80, false)).toEqual(['  Cat assistant']);
    expect(entry.render(80, true)).toEqual(['^!>^: Cat assistant']);
  });

  it('escapes a literal caret in a role name', () => {
    const entry = makeRoleEntry({
      id: 'r1',
      name: 'x^2 assistant',
      slug: 'x-2-assistant',
    });
    expect(entry.render(80, true)).toEqual(['^!>^: x^^2 assistant']);
  });
});

describe('renderMultiListPanel', () => {
  it('renders each list title, group titles, and entries, blank-line separated between lists', () => {
    const lists: SelectableList[] = [
      {
        title: 'Roles',
        groups: [
          { entries: [makeRoleEntry({ id: 'r1', name: 'Cat', slug: 'cat' })] },
        ],
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
      `  ${dateTimeSeconds(taskSummary().createdAt)} [${taskSummary().shortcode}] (ready) "${taskSummary().request}"`,
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
              makeRoleEntry({ id: 'r1', name: 'Cat', slug: 'cat' }),
              makeRoleEntry({ id: 'r2', name: 'Dog', slug: 'dog' }),
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

describe('statusColor', () => {
  it('maps known statuses to their markup colour code', () => {
    expect(statusColor('ready')).toBe('^K');
    expect(statusColor('in-progress')).toBe('^C');
    expect(statusColor('in-qa')).toBe('^C');
    expect(statusColor('succeeded')).toBe('^G');
    expect(statusColor('failed')).toBe('^R');
    expect(statusColor('cancelled')).toBe('^Y');
  });
});

describe('renderAssignmentListEntry', () => {
  const row = (overrides: Partial<AssignmentRow> = {}): AssignmentRow => ({
    id: 'a1',
    index: 1,
    role: 'Implementer',
    mode: 'implement',
    status: 'in-progress',
    prompt: 'Write the report',
    agentId: 'agent-1',
    failureReason: null,
    ...overrides,
  });

  it('renders a single truncated line with the index, role, mode, coloured status, and prompt when not selected', () => {
    const lines = renderAssignmentListEntry(row(), false, 70, 4);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('1. Implementer');
    expect(lines[0]).toContain('(implement: ^Cin-progress^:)');
    expect(lines[0]).toContain('"Write the report"');
  });

  it('truncates a long prompt with an ellipsis when not selected', () => {
    const lines = renderAssignmentListEntry(
      row({ prompt: 'a'.repeat(200) }),
      false,
      60,
      4,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('…');
  });

  it('expands to word-wrapped lines (capped at maxLines) with blank spacing when selected', () => {
    const lines = renderAssignmentListEntry(
      row({
        prompt:
          'A very long prompt that should word-wrap across several lines when highlighted and expanded for reading',
      }),
      true,
      30,
      3,
    );
    expect(lines[0]).toBe('');
    expect(lines[lines.length - 1]).toBe('');
    const body = lines.slice(1, -1);
    expect(body.length).toBeLessThanOrEqual(3);
    expect(body[0]).toContain('^!>^: ');
    expect(lines[lines.length - 2].endsWith('"')).toBe(true);
  });

  it('marks a not-yet-begun (ready) row non-selectable via makeAssignmentEntry', () => {
    expect(makeAssignmentEntry(row({ status: 'ready' }), 4).selectable).toBe(
      false,
    );
    expect(
      makeAssignmentEntry(row({ status: 'in-progress' }), 4).selectable,
    ).toBe(true);
  });

  it('appends the failure reason after a failed status', () => {
    const lines = renderAssignmentListEntry(
      row({ status: 'failed', failureReason: 'did not pass QA' }),
      false,
      70,
      4,
    );
    expect(lines[0]).toContain('^Rfailed^: — did not pass QA');
  });

  it('omits the failure reason suffix for a non-failed status even if set', () => {
    const lines = renderAssignmentListEntry(
      row({ status: 'in-progress', failureReason: 'did not pass QA' }),
      false,
      70,
      4,
    );
    expect(lines[0]).not.toContain('did not pass QA');
  });
});

describe('renderTaskPaneHeading', () => {
  it('renders Task id/Status/Prompt lines followed by a blank separator', () => {
    const lines = renderTaskPaneHeading(
      'task-1',
      'ready',
      'Write a report',
      80,
    );
    expect(lines).toEqual([
      'Task id:  task-1',
      'Status:   ^Kready^:',
      'Prompt:   "Write a report"',
      '',
    ]);
  });

  it('colours the status via statusColor', () => {
    const lines = renderTaskPaneHeading('task-1', 'succeeded', 'x', 80);
    expect(lines[1]).toBe('Status:   ^Gsucceeded^:');
  });

  it('word-wraps a long prompt, indenting continuation lines under the opening quote', () => {
    const lines = renderTaskPaneHeading(
      'task-1',
      'ready',
      'A very long prompt that should word-wrap across several lines of the heading block',
      30,
    );
    expect(lines[0]).toBe('Task id:  task-1');
    expect(lines.length).toBeGreaterThan(4);
    expect(lines[2].startsWith('Prompt:   "')).toBe(true);
    expect(lines[3].startsWith('          ')).toBe(true);
    expect(lines[lines.length - 2].endsWith('"')).toBe(true);
    expect(lines[lines.length - 1]).toBe('');
  });
});

describe('renderAssignmentPaneHeading', () => {
  it('renders the full heading block when the role slug and assignment are known', () => {
    const lines = renderAssignmentPaneHeading(
      'agent-1',
      'Cat assistant',
      'cat-assistant',
      {
        id: 'a1',
        shortcode: '000-001-implement',
        status: 'in-progress',
        prompt: 'Write a report',
      },
      80,
    );
    expect(lines).toEqual([
      'Agent id:             agent-1',
      'Role name (and slug): Cat assistant (cat-assistant)',
      'Assignment id:        a1',
      'Assignment shortcode: 000-001-implement',
      'Assignment status:    ^Cin-progress^:',
      'Prompt:               "Write a report"',
      '',
    ]);
  });

  it('falls back to em-dashes for an absent role slug/assignment (a consultation follower)', () => {
    const lines = renderAssignmentPaneHeading(
      'agent-1',
      'Cat assistant',
      undefined,
      undefined,
      80,
    );
    expect(lines).toEqual([
      'Agent id:             agent-1',
      'Role name (and slug): Cat assistant',
      'Assignment id:        —',
      'Assignment shortcode: —',
      'Assignment status:    —',
      'Prompt:               "—"',
      '',
    ]);
  });

  it('escapes a literal caret in agent/role/assignment text', () => {
    const lines = renderAssignmentPaneHeading(
      'a^1',
      'x^2',
      's^3',
      undefined,
      80,
    );
    expect(lines[0]).toBe('Agent id:             a^^1');
    expect(lines[1]).toBe('Role name (and slug): x^^2 (s^^3)');
  });

  it('appends the failure reason after a failed status', () => {
    const lines = renderAssignmentPaneHeading(
      'agent-1',
      'Cat assistant',
      'cat-assistant',
      {
        id: 'a1',
        shortcode: '000-001-implement',
        status: 'failed',
        prompt: 'Write a report',
        failureReason: 'did not pass QA',
      },
      80,
    );
    expect(lines[4]).toBe('Assignment status:    ^Rfailed^: (did not pass QA)');
  });

  it('omits the failure reason suffix when the status is not failed', () => {
    const lines = renderAssignmentPaneHeading(
      'agent-1',
      'Cat assistant',
      'cat-assistant',
      {
        id: 'a1',
        shortcode: '000-001-implement',
        status: 'in-progress',
        prompt: 'Write a report',
        failureReason: 'did not pass QA',
      },
      80,
    );
    expect(lines[4]).toBe('Assignment status:    ^Cin-progress^:');
  });
});
