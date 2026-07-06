import {
  escapeMarkup,
  PaneEntryLog,
  renderPaneHeading,
  renderRoleList,
  renderRosterPane,
  wrapText,
} from './tui-format';

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

describe('renderRoleList', () => {
  it('marks the selected row with an inverse ">" and leaves the rest unmarked', () => {
    const roles = [
      { id: 'r1', name: 'Cat assistant' },
      { id: 'r2', name: 'Chicken assistant' },
    ];
    expect(renderRoleList(roles, 1)).toEqual([
      '  Cat assistant',
      '^!>^: Chicken assistant',
    ]);
  });

  it('shows a placeholder when the company has no roles', () => {
    expect(renderRoleList([], 0)).toEqual(['(no roles in this company)']);
  });

  it('escapes a literal caret in a role name', () => {
    expect(renderRoleList([{ id: 'r1', name: 'x^2 assistant' }], 0)).toEqual([
      '^!>^: x^^2 assistant',
    ]);
  });
});

describe('renderRosterPane', () => {
  it('renders a Slug/Id heading, a prompt, a blank separator, then the role list', () => {
    const { lines, listStartIndex } = renderRosterPane(
      'acme-corp',
      'company-1',
      [{ id: 'r1', name: 'Cat assistant' }],
      0,
    );
    expect(lines).toEqual([
      'Slug: acme-corp',
      'Id: company-1',
      '',
      'Please select a role to initiate a chat:',
      '',
      '^!>^: Cat assistant',
    ]);
    expect(listStartIndex).toBe(5);
  });

  it('escapes a literal caret in the company slug/id', () => {
    const { lines } = renderRosterPane('a^b', 'c^d', [], 0);
    expect(lines[0]).toBe('Slug: a^^b');
    expect(lines[1]).toBe('Id: c^^d');
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
