// These specs drive the REAL terminal-kit widgets, not fakes: the Tui draws
// into an off-screen ScreenBuffer and receives synthetic 'key' events from an
// EventEmitter standing in for the terminal. Assertions read the actual
// rendered characters back out of the buffer — the original implementation
// shipped never rendering anything precisely because its tests faked the
// widget layer, so the fakes agreed with the code's (wrong) assumptions
// about the API.
//
// Layout constants mirrored here for row math (see tui.ts): row 0 = tab bar,
// row 1 = blank gap, row 2.. = pane content (which itself opens with a
// heading — "Name/Id" on chat panes, "Slug/Id" + prompt on the roster).

import type { TaskChangeSummary, WireEvent } from '@tcp/shared';
import { EventEmitter } from 'events';
import { ScreenBuffer } from 'terminal-kit';
import {
  interpretKey,
  resolveTaskListEntryMaxLines,
  Tui,
  tuiRenderer,
  TuiTerminal,
} from './tui';

function taskSummary(
  overrides: Partial<TaskChangeSummary> = {},
): TaskChangeSummary {
  return {
    id: 't1',
    status: 'ready',
    request: 'Write a report',
    shortcode: '000',
    createdAt: '2026-07-03T10:00:00.000Z',
    updatedAt: '2026-07-03T10:00:00.000Z',
    completedSteps: 0,
    totalSteps: 0,
    ...overrides,
  };
}

const WIDTH = 80;
const HEIGHT = 16;
/** Row where a pane's own content (heading, then log/list) begins. */
const CONTENT_TOP = 2;

function makeTui(
  opts: {
    hideReasoning?: boolean;
    width?: number;
    height?: number;
    /** Fixed capacity of the fake screen buffer backing outputDst — see the
     * 'Tui resize resilience' describe block's module comment. Defaults to
     * just past (WIDTH, HEIGHT), the size every other spec resizes within. */
    bufferWidth?: number;
    bufferHeight?: number;
  } = {},
) {
  const emitter = new EventEmitter();
  const term = Object.assign(emitter, {
    width: opts.width ?? WIDTH,
    height: opts.height ?? HEIGHT,
    fullscreen: jest.fn(),
    grabInput: jest.fn(),
    processExit: jest.fn(),
    hideCursor: jest.fn(),
  }) as unknown as TuiTerminal & EventEmitter & { processExit: jest.Mock };
  // The Document pins itself at outputDst coordinates (1,1), so the buffer
  // needs one extra row/column; rows() reads back with that offset applied.
  // `dst` is only used by ScreenBuffer.draw(), never called here — the
  // runtime accepts its absence, but @types marks it required.
  const screen = new ScreenBuffer({
    width: (opts.bufferWidth ?? WIDTH) + 1,
    height: (opts.bufferHeight ?? HEIGHT) + 1,
  } as ScreenBuffer.Options);
  const tui = new Tui({
    term,
    outputDst: screen,
    hideReasoning: opts.hideReasoning,
  });

  /** The visible terminal rows (0-based), as plain strings. */
  const rows = (): string[] =>
    screen
      .dumpChars()
      .split('\n')
      .slice(1, term.height + 1)
      .map((row) => row.slice(1));
  const text = (): string => rows().join('\n');
  /** The character/style attributes at a 0-based (col, row), offset the
   * same way `rows()` is for the Document's (1,1) pinning. */
  const attrAt = (x: number, y: number) => screen.get({ x: x + 1, y: y + 1 });
  const pressKey = (name: string): void => {
    emitter.emit('key', name, [name], {
      isCharacter: name.length === 1,
      codepoint: name.codePointAt(0),
    });
  };
  const type = (s: string): void => {
    for (const ch of s) pressKey(ch);
  };
  /** Left-clicks a 0-based (col, row), offset for the Document's (1,1) pinning
   * the same way `rows()` is — terminal mouse coordinates are 1-based. */
  const click = (x: number, y: number): void => {
    emitter.emit('mouse', 'MOUSE_LEFT_BUTTON_PRESSED', { x: x + 1, y: y + 1 });
  };
  return { tui, term, rows, text, attrAt, pressKey, type, click };
}

/** An agent `state_change` WireEvent — the pane renders `state_change:agent | <status>`. */
function statusEvent(status: string): WireEvent {
  return {
    type: 'audit',
    event: {
      timestamp: new Date().toISOString(),
      companyId: 'c',
      role: 'r',
      agentId: 'ag',
      assignmentId: null,
      taskId: null,
      eventType: 'state_change',
      payload: { entity: 'agent', newStatus: status },
    },
  };
}

/** A reasoning/response stream-delta WireEvent. */
function deltaEvent(
  channel: 'reasoning' | 'response',
  delta: string,
): WireEvent {
  return {
    type: 'stream',
    agentId: 'ag',
    channel,
    delta,
    timestamp: new Date().toISOString(),
  };
}

describe('interpretKey', () => {
  it('maps TAB to next-pane and SHIFT_TAB to prev-pane', () => {
    expect(interpretKey('TAB')).toBe('next-pane');
    expect(interpretKey('SHIFT_TAB')).toBe('prev-pane');
  });

  it('maps CTRL_C to quit', () => {
    expect(interpretKey('CTRL_C')).toBe('quit');
  });

  it('maps ordinary keys to none, so they reach the focused widget unchanged', () => {
    expect(interpretKey('a')).toBe('none');
    expect(interpretKey('ENTER')).toBe('none');
    expect(interpretKey('UP')).toBe('none');
  });
});

describe('resolveTaskListEntryMaxLines', () => {
  const ENV_VAR = 'TCP_TASK_LIST_ENTRY_MAX_LINES';
  const originalEnv = process.env[ENV_VAR];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = originalEnv;
  });

  it('defaults to 4 when neither a flag nor the env var is given', () => {
    delete process.env[ENV_VAR];
    expect(resolveTaskListEntryMaxLines(undefined)).toBe(4);
  });

  it('uses the env var when no flag is given', () => {
    process.env[ENV_VAR] = '7';
    expect(resolveTaskListEntryMaxLines(undefined)).toBe(7);
  });

  it('the flag takes precedence over the env var', () => {
    process.env[ENV_VAR] = '7';
    expect(resolveTaskListEntryMaxLines('2')).toBe(2);
  });

  it('falls back to the default for a non-integer flag value', () => {
    delete process.env[ENV_VAR];
    expect(resolveTaskListEntryMaxLines('abc')).toBe(4);
  });

  it('falls back to the default for a zero or negative value', () => {
    delete process.env[ENV_VAR];
    expect(resolveTaskListEntryMaxLines('0')).toBe(4);
    expect(resolveTaskListEntryMaxLines('-3')).toBe(4);
  });

  it('falls back to the default for a non-integer env var value', () => {
    process.env[ENV_VAR] = 'garbage';
    expect(resolveTaskListEntryMaxLines(undefined)).toBe(4);
  });
});

describe('Tui rendering', () => {
  it('shows the pane label as the active tab on the top row', () => {
    const { tui, rows } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat Assistant', talkable: true });
    expect(rows()[0]).toContain('[ Cat Assistant ]');
  });

  it('opens each chat pane with the agent/role/assignment heading, falling back to "—" for an unknown role slug/assignment', () => {
    const { tui, rows } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });
    expect(rows()[CONTENT_TOP]).toContain('Agent id:             root');
    expect(rows()[CONTENT_TOP + 1]).toContain('Role name (and slug): Cat');
    expect(rows()[CONTENT_TOP + 2]).toContain('Assignment id:        —');
  });

  it('shows the role slug and assignment fields in the heading when given', () => {
    const { tui, rows } = makeTui();
    tui.addPane({
      id: 'agent-1',
      label: 'Cat',
      talkable: true,
      roleSlug: 'cat-assistant',
      assignment: {
        id: 'a1',
        shortcode: '000-000-plan',
        status: 'in-progress',
        prompt: 'Do the thing',
      },
    });
    expect(rows()[CONTENT_TOP + 1]).toContain(
      'Role name (and slug): Cat (cat-assistant)',
    );
    expect(rows()[CONTENT_TOP + 2]).toContain('Assignment id:        a1');
    expect(rows()[CONTENT_TOP + 3]).toContain(
      'Assignment shortcode: 000-000-plan',
    );
  });

  it('renders appended discrete events into the pane scrollback', () => {
    const { tui, text } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });
    tui.appendEvent('root', statusEvent('running'));
    expect(text()).toMatch(/\d\d:\d\d:\d\d \| state_change:agent \| running/);
  });

  it('accumulates reasoning deltas as one indented block', () => {
    const { tui, text } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });
    for (const delta of ['thinking', ' about', ' kibble']) {
      tui.appendEvent('root', deltaEvent('reasoning', delta));
    }
    expect(text()).toContain('  thinking about kibble');
  });

  it('shows key hints on the bottom row', () => {
    const { tui, rows, term } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });
    expect(rows()[term.height - 1]).toContain('Ctrl+C quit');
    expect(rows()[term.height - 1]).toContain('Enter send');
  });

  it('switches panes with Tab/Shift+Tab, updating tab highlight and visible content', () => {
    const { tui, text, rows, pressKey } = makeTui();
    tui.addPane({ id: 'a', label: 'Cat', talkable: true });
    tui.addPane({ id: 'b', label: 'Chicken', talkable: false });
    tui.appendEvent('a', statusEvent('cat-marker'));
    tui.appendEvent('b', statusEvent('chicken-marker'));

    expect(text()).toContain('cat-marker');
    expect(text()).not.toContain('chicken-marker');

    pressKey('TAB');
    expect(rows()[0]).toContain('[ Chicken ]');
    expect(text()).toContain('chicken-marker');
    expect(text()).not.toContain('cat-marker');

    pressKey('SHIFT_TAB');
    expect(text()).toContain('cat-marker');
  });

  it('removes a pane from the tab bar on removePane', () => {
    const { tui, rows } = makeTui();
    tui.addPane({ id: 'a', label: 'Cat', talkable: true });
    tui.addPane({ id: 'b', label: 'Chicken', talkable: false });
    tui.removePane('b');
    expect(rows()[0]).not.toContain('Chicken');
  });

  it('re-renders on terminal resize instead of losing the screen', () => {
    const { tui, term, rows } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });
    (term as { height: number }).height = 12;
    (term as unknown as EventEmitter).emit('resize', WIDTH, 12);
    expect(rows()[0]).toContain('[ Cat ]');
    expect(rows()[11]).toContain('Ctrl+C quit');
  });
});

describe('Tui colour markup', () => {
  it('renders reasoning text in a distinct (bright black/grey) colour', () => {
    const { tui, text, attrAt } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });
    tui.appendEvent('root', deltaEvent('reasoning', 'thinking'));
    // Heading occupies 7 rows, then the reasoning block's own header + blank
    // line, so the indented 'thinking' body sits two rows below that.
    const bodyRow = CONTENT_TOP + 7 + 2;
    expect(text()).toContain('thinking');
    expect(attrAt(2, bodyRow).char).toBe('t');
    expect(attrAt(2, bodyRow).attr.color).toBe(8); // bright black (^K)
  });

  it('does not render raw markup codes as visible text', () => {
    const { tui, text } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });
    tui.appendEvent('root', deltaEvent('reasoning', 'thinking'));
    expect(text()).not.toContain('^K');
    expect(text()).not.toContain('^:');
  });

  it('escapes a literal caret in model-provided text so it displays as one caret, not a corrupted colour', () => {
    const { tui, text } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });
    tui.appendEvent('root', deltaEvent('response', 'x^2 + y^2'));
    expect(text()).toContain('x^2 + y^2');
  });

  it('bolds the active tab and leaves inactive tabs unstyled', () => {
    const { tui, attrAt, pressKey } = makeTui();
    tui.addPane({ id: 'a', label: 'Cat', talkable: true });
    tui.addPane({ id: 'b', label: 'Chicken', talkable: false });

    // "[ Cat ]" starts at column 0 on the tab row (row 0); 'C' of "Cat" is at column 2.
    expect(attrAt(2, 0).attr.bold).toBe(true);

    pressKey('TAB');
    // Now 'b' ("Chicken") is active; the inactive "Cat" tab (now first,
    // unbracketed, 2-space padded) should no longer be bold.
    expect(attrAt(2, 0).attr.bold).toBeFalsy();
  });
});

describe('Tui cursor visibility', () => {
  it('shows the terminal cursor on an enabled, talkable pane', () => {
    const { tui, term } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });
    expect(term.hideCursor).toHaveBeenLastCalledWith(false);
  });

  it('hides the cursor on a spectator pane (no editable input)', () => {
    const { tui, term, pressKey } = makeTui();
    tui.addPane({ id: 'a', label: 'Cat', talkable: true });
    tui.addPane({ id: 'b', label: 'Chicken', talkable: false });
    pressKey('TAB'); // to the spectator pane
    expect(term.hideCursor).toHaveBeenLastCalledWith(true);
  });

  it('hides the cursor on the company roster (no editable input)', () => {
    const { tui, term } = makeTui();
    tui.addRosterPane({
      id: 'acme',
      label: 'Acme Corp',
      slug: 'acme',
      roles: [],
    });
    expect(term.hideCursor).toHaveBeenLastCalledWith(true);
  });

  it('hides the cursor while the active pane is busy, and shows it again once idle', () => {
    const { tui, term } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });

    tui.setBusy('root', true);
    expect(term.hideCursor).toHaveBeenLastCalledWith(true);

    tui.setBusy('root', false);
    expect(term.hideCursor).toHaveBeenLastCalledWith(false);
  });

  it('always shows the cursor again on stop(), regardless of prior state', () => {
    const { tui, term } = makeTui();
    tui.addRosterPane({
      id: 'acme',
      label: 'Acme Corp',
      slug: 'acme',
      roles: [],
    });
    expect(term.hideCursor).toHaveBeenLastCalledWith(true);

    tui.stop();
    expect(term.hideCursor).toHaveBeenLastCalledWith(false);
  });
});

describe('Tui input box', () => {
  it('shows a prompt on talkable panes and echoes typed text', () => {
    const { tui, text, type } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });
    type('hi there');
    expect(text()).toContain('> hi there');
  });

  it('focuses the input immediately when a talkable pane is added while another pane is active, then switched to (the roster "initiate chat" flow)', () => {
    // Regression coverage for the roster's real onSelectRole flow: the
    // roster is active when addPane() creates the new (not-yet-active)
    // talkable pane, and switchToPane() only follows afterwards (once the
    // pane's backing agent/assignment fetch resolves) — a gap where a
    // still-old `this.input` reference or a missed giveFocusTo() could
    // silently leave the roster (or nothing) focused instead.
    const { tui, type, pressKey } = makeTui();
    tui.addRosterPane({
      id: 'acme',
      label: 'Acme',
      slug: 'acme-corp',
      roles: [{ id: 'r1', name: 'Chicken assistant' }],
    });
    tui.addPane({ id: 'agent-1', label: 'Chicken assistant', talkable: true });
    tui.switchToPane('agent-1');

    const onSubmit = jest.fn();
    tui.onSubmit(onSubmit);
    type('Tell me about yourself.');
    pressKey('ENTER');

    expect(onSubmit).toHaveBeenCalledWith('Tell me about yourself.', 'agent-1');
  });

  it('submits on Enter with the trimmed value and clears the input', () => {
    const { tui, text, type, pressKey } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });
    const onSubmit = jest.fn();
    tui.onSubmit(onSubmit);

    type('  hello  ');
    pressKey('ENTER');

    expect(onSubmit).toHaveBeenCalledWith('hello', 'root');
    expect(text()).not.toContain('hello');
  });

  it('inserts a newline on Alt+Enter instead of submitting', () => {
    const { tui, type, pressKey } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });
    const onSubmit = jest.fn();
    tui.onSubmit(onSubmit);

    type('ab');
    pressKey('ALT_ENTER');
    type('cd');
    expect(onSubmit).not.toHaveBeenCalled();

    pressKey('ENTER');
    expect(onSubmit).toHaveBeenCalledWith('ab\ncd', 'root');
  });

  it('supports arrow-key editing within the input', () => {
    const { tui, type, pressKey } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });
    const onSubmit = jest.fn();
    tui.onSubmit(onSubmit);

    type('ac');
    pressKey('LEFT');
    type('b');
    pressKey('ENTER');

    expect(onSubmit).toHaveBeenCalledWith('abc', 'root');
  });

  it('hides the input on spectator panes and restores the draft when switching back', () => {
    const { tui, text, type, pressKey } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });
    tui.addPane({ id: 'spec', label: 'Chicken', talkable: false });

    type('draft');
    pressKey('TAB'); // to the spectator pane
    expect(text()).not.toContain('> ');
    expect(text()).not.toContain('Enter send');

    pressKey('TAB'); // back to the talkable pane
    expect(text()).toContain('> draft');
  });

  it('blocks submission while busy, then submits the preserved text when idle again', () => {
    const { tui, rows, term, type, pressKey } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });
    const onSubmit = jest.fn();
    tui.onSubmit(onSubmit);

    tui.setBusy('root', true);
    expect(rows()[term.height - 1]).toContain('waiting for response');
    type('queued');
    pressKey('ENTER');
    expect(onSubmit).not.toHaveBeenCalled();

    tui.setBusy('root', false);
    pressKey('ENTER');
    expect(onSubmit).toHaveBeenCalledWith('queued', 'root');
  });

  it('routes submit and busy state per-pane when multiple talkable panes exist', () => {
    const { tui, rows, term, text, type, pressKey } = makeTui();
    tui.addPane({ id: 'a', label: 'Cat', talkable: true });
    tui.addPane({ id: 'b', label: 'Chicken', talkable: true });
    const onSubmit = jest.fn();
    tui.onSubmit(onSubmit);

    // Draft typed on 'a' survives a switch to 'b' and back, independently.
    type('for-cat');
    pressKey('TAB');
    expect(text()).not.toContain('for-cat');
    type('for-chicken');
    expect(text()).toContain('> for-chicken');

    // Busy on 'b' only affects 'b's hint row and submission.
    tui.setBusy('b', true);
    expect(rows()[term.height - 1]).toContain('waiting for response');
    pressKey('ENTER');
    expect(onSubmit).not.toHaveBeenCalled();

    pressKey('SHIFT_TAB'); // back to 'a', which isn't busy
    expect(text()).toContain('> for-cat');
    expect(rows()[term.height - 1]).toContain('Enter send');
    pressKey('ENTER');
    expect(onSubmit).toHaveBeenCalledWith('for-cat', 'a');

    tui.setBusy('b', false);
    pressKey('TAB');
    expect(text()).toContain('> for-chicken');
    pressKey('ENTER');
    expect(onSubmit).toHaveBeenCalledWith('for-chicken', 'b');
  });

  // The input occupies one row at the top of the INPUT_ROWS=3 band reserved
  // for it (rows height-4 .. height-2, above the hint row), growing down into
  // the rest only once Alt+Enter adds lines. Both specs below drive focus
  // purely through the public surface — typed text only reaches the input when
  // it genuinely holds focus.
  const INPUT_TOP_ROW = HEIGHT - 1 - 3;

  it('takes focus back when a turn ends, after a scrollback click moved it away', () => {
    const { tui, text, type, click } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });

    tui.setBusy('root', true);
    // Reading/selecting the streaming answer focuses the pane's scrollback —
    // it is a scrollable TextBox, so terminal-kit hands focus to it.
    click(10, CONTENT_TOP + 1);
    type('ignored');
    expect(text()).not.toContain('> ignored');

    tui.setBusy('root', false);
    type('next question');
    expect(text()).toContain('> next question');
  });

  it('focuses the input from a click anywhere in its reserved band, including the prompt', () => {
    // x=0 is the '> ' prompt (a non-scrollable TextBox child that never takes
    // focus itself); the two rows below the input hold no element at all.
    for (const [x, y] of [
      [0, INPUT_TOP_ROW],
      [10, INPUT_TOP_ROW + 1],
      [10, INPUT_TOP_ROW + 2],
    ]) {
      const { tui, text, type, click } = makeTui();
      tui.addPane({ id: 'root', label: 'Cat', talkable: true });
      click(10, CONTENT_TOP + 1); // move focus off the input
      type('ignored');
      expect(text()).not.toContain('> ignored');

      click(x, y);
      type('typed');
      expect(text()).toContain('> typed');
    }
  });
});

describe('Tui scrolling', () => {
  it('PgUp stops following the tail; PgDn back to the bottom resumes it', () => {
    const { tui, text, pressKey } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });
    // Enough entries (each blank-line separated) to overflow the pane.
    for (let i = 0; i < 40; i++) {
      tui.appendEvent('root', statusEvent(`entry-${i}`));
    }
    expect(text()).toContain('entry-39');

    pressKey('PAGE_UP');
    tui.appendEvent('root', statusEvent('tail-marker'));
    expect(text()).not.toContain('tail-marker');

    // Page back down past the bottom — following resumes.
    for (let i = 0; i < 20; i++) pressKey('PAGE_DOWN');
    tui.appendEvent('root', statusEvent('resumed-marker'));
    expect(text()).toContain('resumed-marker');
  });
});

describe('Tui resize resilience', () => {
  function resize(
    term: { width: number; height: number },
    w: number,
    h: number,
  ): void {
    term.width = w;
    term.height = h;
    (term as unknown as EventEmitter).emit('resize', w, h);
  }

  it('survives a resize to a degenerate terminal (height ≤ 4) on a talkable pane, and recovers when it grows back', () => {
    const { tui, term, rows } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });

    expect(() => resize(term, 2, 3)).not.toThrow();
    // Sane render: no exception, and it's still safe to keep interacting
    // with the pane while the terminal is this small.
    expect(() =>
      tui.appendEvent('root', statusEvent('still-alive')),
    ).not.toThrow();

    // Recovers fully once the terminal grows back — no lingering corruption
    // from having passed through the degenerate size.
    resize(term, WIDTH, HEIGHT);
    expect(rows()[0]).toContain('[ Cat ]');
  });

  it('survives a resize to a degenerate terminal (width ≤ 2) on a non-talkable (roster) pane, and recovers when it grows back', () => {
    const { tui, term, rows } = makeTui();
    tui.addRosterPane({
      id: 'acme',
      label: 'Acme',
      slug: 'acme-corp',
      roles: [{ id: 'r1', name: 'Cat assistant' }],
    });

    expect(() => resize(term, 2, 4)).not.toThrow();

    resize(term, WIDTH, HEIGHT);
    expect(rows()[0]).toContain('[ Acme ]');
    expect(rows().join('\n')).toContain('Cat assistant');
  });

  it('treats a terminal-kit 1×1 degenerate resize as "too small" without throwing, and recovers on the next real-size resize', () => {
    const { tui, term, rows } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });

    expect(() => resize(term, 1, 1)).not.toThrow();
    expect(() => resize(term, WIDTH, HEIGHT)).not.toThrow();
    expect(rows()[0]).toContain('[ Cat ]');
  });

  it('drops the input box when shrunk too short to hold it, and restores it when grown back', () => {
    const { tui, term, rows } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });
    expect(rows().some((r) => r.includes('>'))).toBe(true); // the input prompt

    resize(term, WIDTH, 3);
    // Too short for the input row above the hint bar — dropped, not placed
    // at an invalid/overlapping position.
    expect(rows()[0]).toContain('Cat');

    resize(term, WIDTH, HEIGHT);
    // Re-layout on growing back restores the input and the chrome.
    expect(rows()[0]).toContain('[ Cat ]');
    expect(rows()[HEIGHT - 1]).toContain('Ctrl+C quit');
  });

  it('survives growing a scrolled, scrollbar-showing terminal without throwing an offset-out-of-range error', () => {
    // Reproduces a real report: a roster pane long enough to need its
    // vScrollBar, scrolled away from the top, then the terminal grown
    // (not shrunk) through several sizes. `bufferWidth`/`bufferHeight` give
    // the fake screen buffer backing outputDst plenty of headroom above
    // every size resized to below, so this isolates the resize handler's
    // own ordering bug from the unrelated "grew past the fake buffer's own
    // fixed capacity" concern a real terminal never has.
    const { tui, term, rows, pressKey } = makeTui({
      width: 40,
      height: 10,
      bufferWidth: 120,
      bufferHeight: 40,
    });
    tui.addRosterPane({
      id: 'acme',
      label: 'Acme',
      slug: 'acme-corp',
      roles: Array.from({ length: 30 }, (_, i) => ({
        id: `r${i}`,
        name: `Role ${i} with a fairly long name to force wrapping`,
      })),
    });
    for (let i = 0; i < 20; i++) pressKey('DOWN');

    for (const [w, h] of [
      [45, 12],
      [60, 14],
      [80, 16],
      [41, 11],
      [100, 30],
    ]) {
      expect(() => resize(term, w, h)).not.toThrow();
    }
    expect(rows()[0]).toContain('[ Acme ]');
  });

  it('survives a company SSE task_changed update (updateRosterTasks) landing while the terminal is degenerate', () => {
    const { tui, term, rows } = makeTui();
    tui.addRosterPane({
      id: 'acme',
      label: 'Acme',
      slug: 'acme-corp',
      roles: [{ id: 'r1', name: 'Cat assistant' }],
    });

    expect(() => resize(term, 2, 4)).not.toThrow();
    // A task_changed-driven update landing while the pane is hidden/
    // unpositioned (too small for content) must not throw.
    expect(() =>
      tui.updateRosterTasks('acme', [
        taskSummary({ id: 't1', request: 'Mid-resize task' }),
      ]),
    ).not.toThrow();

    resize(term, WIDTH, HEIGHT);
    expect(rows().join('\n')).toContain('Mid-resize task');
  });
});

describe('Tui company roster pane', () => {
  it('renders the role list with the first row highlighted by default', () => {
    const { tui, rows, text } = makeTui();
    tui.addRosterPane({
      id: 'acme',
      label: 'Acme Corp',
      slug: 'acme-corp',
      roles: [
        { id: 'r1', name: 'Cat assistant' },
        { id: 'r2', name: 'Chicken assistant' },
      ],
    });
    expect(rows()[0]).toContain('[ Acme Corp ]');
    expect(text()).toContain('> Cat assistant');
    expect(text()).toContain('  Chicken assistant');
  });

  it('opens with a Slug/Id heading, a prompt, a blank line, then the Roles list title before the list', () => {
    const { tui, rows } = makeTui();
    tui.addRosterPane({
      id: 'acme',
      label: 'Acme Corp',
      slug: 'acme-corp',
      roles: [{ id: 'r1', name: 'Cat assistant' }],
    });
    expect(rows()[CONTENT_TOP]).toContain('Slug: acme-corp');
    expect(rows()[CONTENT_TOP + 1]).toContain('Id: acme');
    expect(rows()[CONTENT_TOP + 2].trim()).toBe('');
    expect(rows()[CONTENT_TOP + 3]).toContain(
      'Please select a role to initiate a chat:',
    );
    expect(rows()[CONTENT_TOP + 4].trim()).toBe('');
    expect(rows()[CONTENT_TOP + 5]).toContain('Roles');
    expect(rows()[CONTENT_TOP + 6]).toContain('> Cat assistant');
  });

  it('inverts the colour of the ">" marker on the selected row only', () => {
    const { tui, attrAt } = makeTui();
    tui.addRosterPane({
      id: 'acme',
      label: 'Acme Corp',
      slug: 'acme-corp',
      roles: [
        { id: 'r1', name: 'Cat assistant' },
        { id: 'r2', name: 'Chicken assistant' },
      ],
    });
    const selectedRow = CONTENT_TOP + 6;
    expect(attrAt(0, selectedRow).char).toBe('>');
    expect(attrAt(0, selectedRow).attr.inverse).toBe(true);
    expect(attrAt(0, selectedRow + 1).char).toBe(' ');
    expect(attrAt(0, selectedRow + 1).attr.inverse).toBeFalsy();
  });

  it('has no input box and shows roster-specific hints', () => {
    const { tui, rows, term } = makeTui();
    tui.addRosterPane({
      id: 'acme',
      label: 'Acme Corp',
      slug: 'acme-corp',
      roles: [{ id: 'r1', name: 'Cat assistant' }],
    });
    expect(rows()[term.height - 1]).not.toContain('Enter send');
    expect(rows()[term.height - 1]).toContain('Up/Down select');
    expect(rows()[term.height - 1]).toContain('Enter chat');
    expect(rows()[term.height - 1]).toContain('r refresh');
  });

  it('moves the highlight with Up/Down, wrapping at the ends', () => {
    const { tui, text, pressKey } = makeTui();
    tui.addRosterPane({
      id: 'acme',
      label: 'Acme Corp',
      slug: 'acme-corp',
      roles: [
        { id: 'r1', name: 'Cat assistant' },
        { id: 'r2', name: 'Chicken assistant' },
      ],
    });

    pressKey('DOWN');
    expect(text()).toContain('> Chicken assistant');
    expect(text()).toContain('  Cat assistant');

    pressKey('DOWN'); // wraps back to the first row
    expect(text()).toContain('> Cat assistant');

    pressKey('UP'); // wraps the other way, back to the last row
    expect(text()).toContain('> Chicken assistant');
  });

  it('shows the company Tasks list grouped Active/Completed-or-failed, and `>` navigation crosses from Roles into Tasks, cycling top↔bottom', () => {
    const { tui, rows, text, pressKey } = makeTui();
    tui.addRosterPane({
      id: 'acme',
      label: 'Acme Corp',
      slug: 'acme-corp',
      roles: [{ id: 'r1', name: 'Cat assistant' }],
    });
    tui.updateRosterTasks('acme', [
      taskSummary({
        id: 't1',
        status: 'in-progress',
        completedSteps: 1,
        totalSteps: 2,
        request: 'Active task',
      }),
      taskSummary({
        id: 't2',
        status: 'succeeded',
        request: 'Done task',
      }),
    ]);

    // A selected task entry expands and pads with blank lines (see
    // renderTaskListEntry), shifting row numbers around it — so look up each
    // row by its distinguishing text rather than a fixed offset.
    const markerFor = (needle: string): string =>
      rows().find((r) => r.includes(needle))![0];

    expect(text()).toContain('Active');
    expect(text()).toContain('Completed / failed');
    expect(text()).toContain('in progress: 1/2');

    expect(markerFor('Cat assistant')).toBe('>');

    pressKey('DOWN');
    expect(markerFor('Cat assistant')).toBe(' ');
    expect(markerFor('Active task')).toBe('>');

    pressKey('DOWN');
    expect(markerFor('Active task')).toBe(' ');
    expect(markerFor('Done task')).toBe('>');

    // Cycles back to the top (the role) rather than stopping at the bottom.
    pressKey('DOWN');
    expect(markerFor('Done task')).toBe(' ');
    expect(markerFor('Cat assistant')).toBe('>');
  });

  it('the [ / ] shortcut jumps the highlight to the first entry of the previous/next list', () => {
    const { tui, rows, pressKey } = makeTui();
    tui.addRosterPane({
      id: 'acme',
      label: 'Acme Corp',
      slug: 'acme-corp',
      roles: [
        { id: 'r1', name: 'Cat assistant' },
        { id: 'r2', name: 'Chicken assistant' },
      ],
    });
    tui.updateRosterTasks('acme', [
      taskSummary({ id: 't1', request: 'Active task' }),
    ]);
    const markerFor = (needle: string): string =>
      rows().find((r) => r.includes(needle))![0];

    pressKey(']');
    expect(markerFor('Active task')).toBe('>');
    expect(markerFor('Cat assistant')).toBe(' ');

    pressKey(']'); // wraps back to Roles
    expect(markerFor('Cat assistant')).toBe('>');

    pressKey('['); // and back the other way
    expect(markerFor('Active task')).toBe('>');
  });

  it('scrolls to keep the highlighted role in view as the selection moves past the visible window', () => {
    const { tui, text, pressKey } = makeTui();
    const roles = Array.from({ length: 15 }, (_, i) => ({
      id: `r${i}`,
      name: `Role ${String(i).padStart(2, '0')}`,
    }));
    tui.addRosterPane({
      id: 'acme',
      label: 'Acme Corp',
      slug: 'acme-corp',
      roles,
    });

    expect(text()).toContain('Role 00');

    for (let i = 0; i < roles.length - 1; i++) pressKey('DOWN');

    expect(text()).toContain('Role 14');
    expect(text()).not.toContain('Role 00');
  });

  it('calls onSelectRole with the highlighted role on Enter', () => {
    const { tui, pressKey } = makeTui();
    tui.addRosterPane({
      id: 'acme',
      label: 'Acme Corp',
      slug: 'acme-corp',
      roles: [
        { id: 'r1', name: 'Cat assistant' },
        { id: 'r2', name: 'Chicken assistant' },
      ],
    });
    const onSelectRole = jest.fn();
    tui.onSelectRole(onSelectRole);

    pressKey('DOWN');
    pressKey('ENTER');

    expect(onSelectRole).toHaveBeenCalledWith({
      id: 'r2',
      name: 'Chicken assistant',
    });
  });

  it("calls onRefreshRoster on 'r' and re-renders via updateRosterRoles", () => {
    const { tui, text, pressKey } = makeTui();
    tui.addRosterPane({
      id: 'acme',
      label: 'Acme Corp',
      slug: 'acme-corp',
      roles: [{ id: 'r1', name: 'Cat assistant' }],
    });
    const onRefreshRoster = jest.fn(() => {
      tui.updateRosterRoles('acme', [
        { id: 'r1', name: 'Cat assistant' },
        { id: 'r2', name: 'Chicken assistant' },
      ]);
    });
    tui.onRefreshRoster(onRefreshRoster);

    pressKey('r');

    expect(onRefreshRoster).toHaveBeenCalled();
    expect(text()).toContain('Chicken assistant');
  });

  it('switchToPane activates a talkable pane started from the roster', () => {
    const { tui, rows, text } = makeTui();
    tui.addRosterPane({
      id: 'acme',
      label: 'Acme Corp',
      slug: 'acme-corp',
      roles: [{ id: 'r1', name: 'Cat assistant' }],
    });
    tui.addPane({ id: 'r1', label: 'Cat assistant', talkable: true });

    tui.switchToPane('r1');

    expect(rows()[0]).toContain('[ Cat assistant ]');
    expect(text()).toContain('> '); // input box now shown for the talkable pane
  });

  it('opens a task panel and switches to it on Enter over a task entry', () => {
    const { tui, rows, pressKey } = makeTui();
    tui.addRosterPane({
      id: 'acme',
      label: 'Acme Corp',
      slug: 'acme-corp',
      roles: [{ id: 'r1', name: 'Cat assistant' }],
    });
    tui.updateRosterTasks('acme', [
      taskSummary({ id: 't1', request: 'Write a report' }),
    ]);
    const onSelectTask = jest.fn((task: TaskChangeSummary) => {
      tui.addTaskPane({
        id: task.id,
        label: task.id,
        prompt: task.request,
        status: task.status,
        assignments: [],
      });
      tui.switchToPane(task.id);
    });
    tui.onSelectTask(onSelectTask);

    pressKey(']'); // jump from Roles to Tasks
    pressKey('ENTER');

    expect(onSelectTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1' }),
    );
    expect(rows()[0]).toContain('[ t1 ]');
    expect(rows()[CONTENT_TOP]).toContain('Task id:  t1');
  });
});

describe('Tui task panel', () => {
  function addTask(
    tui: ReturnType<typeof makeTui>['tui'],
    overrides: Partial<{
      status: string;
      assignments: Parameters<Tui['addTaskPane']>[0]['assignments'];
    }> = {},
  ) {
    tui.addTaskPane({
      id: 'task-1',
      label: 'task-1',
      prompt: 'Write a report',
      status: overrides.status ?? 'in-progress',
      assignments: overrides.assignments ?? [
        {
          id: 'a1',
          role: 'Planner',
          mode: 'plan',
          status: 'succeeded',
          prompt: 'Draft the plan',
          agentId: 'agent-1',
        },
        {
          id: 'a2',
          role: 'Implementer',
          mode: 'implement',
          status: 'in-progress',
          prompt: 'Write the report body',
          agentId: 'agent-2',
        },
        {
          id: 'a3',
          role: 'QA',
          mode: 'qa',
          status: 'ready',
          prompt: 'Review the report',
          agentId: null,
        },
      ],
    });
  }

  it('renders the Task id/Status/Prompt heading and the Assignments list', () => {
    const { tui, rows } = makeTui();
    addTask(tui);
    expect(rows()[CONTENT_TOP]).toContain('Task id:  task-1');
    expect(rows()[CONTENT_TOP + 1]).toContain('Status:   in-progress');
    expect(rows()[CONTENT_TOP + 2]).toContain('Prompt:   "Write a report"');
    expect(rows()[CONTENT_TOP + 4]).toContain('Assignments');
  });

  it('`>` skips not-yet-begun (ready) assignments, cycling within the selectable rows across both groups', () => {
    const { tui, text, pressKey } = makeTui();
    addTask(tui);

    // The Incomplete group renders first: a2 (Implementer, in-progress) is
    // its only selectable row (a3/QA is ready — never selectable). Complete
    // (a1/Planner, succeeded) follows. Each keeps its plan index (array
    // position, since these fixtures set no explicit planIndex) — 1 for
    // Implementer, 0 for Planner — regardless of which group it's in.
    expect(text()).toContain('> 1. Implementer');

    pressKey('DOWN');
    expect(text()).toContain('> 0. Planner');

    pressKey('DOWN'); // wraps back to a2 — a3 is never selectable
    expect(text()).toContain('> 1. Implementer');
  });

  it('colours each assignment status via terminal attributes', () => {
    const { tui, rows, attrAt } = makeTui();
    addTask(tui);
    const succeededRow = rows().findIndex((r) => r.includes('Planner'));
    const col = rows()[succeededRow].indexOf('succeeded');
    // Bright green foreground (terminal-kit's 16-colour "bright" palette:
    // base colour 2 + 8) for a succeeded assignment.
    expect(attrAt(col, succeededRow).attr.color).toBe(10);
  });

  it('opens the assignment chat panel via onSelectAssignment on Enter over a begun assignment', () => {
    const { tui, pressKey } = makeTui();
    addTask(tui);
    const onSelectAssignment = jest.fn();
    tui.onSelectAssignment(onSelectAssignment);

    // The first selectable row is a2 (Implementer) — the Incomplete group
    // renders before Complete, and a3 (ready) is never selectable.
    pressKey('ENTER');

    expect(onSelectAssignment).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ id: 'a2', role: 'Implementer' }),
    );
  });

  it('updates the assignment list live (e.g. an SSE assignment_changed update)', () => {
    const { tui, text } = makeTui();
    addTask(tui);
    expect(text()).toContain('in-progress');

    tui.updateTaskPaneAssignments('task-1', [
      {
        id: 'a1',
        role: 'Planner',
        mode: 'plan',
        status: 'succeeded',
        prompt: 'Draft the plan',
        agentId: 'agent-1',
      },
      {
        id: 'a2',
        role: 'Implementer',
        mode: 'implement',
        status: 'succeeded',
        prompt: 'Write the report body',
        agentId: 'agent-2',
      },
      {
        id: 'a3',
        role: 'QA',
        mode: 'qa',
        status: 'in-progress',
        prompt: 'Review the report',
        agentId: 'agent-3',
      },
    ]);

    // No explicit planIndex on these fixtures — falls back to array position
    // (0-based), and QA (still incomplete) keeps its position even though
    // Planner/Implementer moved to the Complete group above it.
    expect(text()).toContain('2. QA');
    expect(text()).not.toContain('1. Implementer (in-progress)');
  });

  it('shows the cancel shortcut only while the task is running, and fires onCancelTask', () => {
    const { tui, rows, term, pressKey } = makeTui();
    addTask(tui, { status: 'in-progress' });
    const onCancelTask = jest.fn();
    tui.onCancelTask(onCancelTask);

    expect(rows()[term.height - 1]).toContain('c cancel');
    pressKey('c');
    expect(onCancelTask).toHaveBeenCalledWith('task-1');
  });

  it('hides the cancel shortcut and ignores "c" once the task is no longer running', () => {
    const { tui, rows, term, pressKey } = makeTui();
    addTask(tui, { status: 'succeeded' });
    const onCancelTask = jest.fn();
    tui.onCancelTask(onCancelTask);

    expect(rows()[term.height - 1]).not.toContain('c cancel');
    pressKey('c');
    expect(onCancelTask).not.toHaveBeenCalled();
  });

  it('shows the start shortcut only while the task is ready, and fires onStartTask', () => {
    const { tui, rows, term, pressKey } = makeTui();
    addTask(tui, { status: 'ready' });
    const onStartTask = jest.fn();
    tui.onStartTask(onStartTask);

    expect(rows()[term.height - 1]).toContain('s start');
    pressKey('s');
    expect(onStartTask).toHaveBeenCalledWith('task-1');
  });

  it('hides the start shortcut and ignores "s" once the task is no longer ready', () => {
    const { tui, rows, term, pressKey } = makeTui();
    addTask(tui, { status: 'in-progress' });
    const onStartTask = jest.fn();
    tui.onStartTask(onStartTask);

    expect(rows()[term.height - 1]).not.toContain('s start');
    pressKey('s');
    expect(onStartTask).not.toHaveBeenCalled();
  });

  it('updateTaskPaneStatus updates the hint bar without needing a full redraw of the list', () => {
    const { tui, rows, term } = makeTui();
    addTask(tui, { status: 'ready' });
    expect(rows()[term.height - 1]).toContain('s start');

    tui.updateTaskPaneStatus('task-1', 'in-progress');

    expect(rows()[term.height - 1]).not.toContain('s start');
    expect(rows()[term.height - 1]).toContain('c cancel');
  });
});

describe('Tui initiate-task panel', () => {
  function openFromRoster(tui: ReturnType<typeof makeTui>['tui']) {
    tui.addRosterPane({
      id: 'acme',
      label: 'Acme Corp',
      slug: 'acme-corp',
      roles: [{ id: 'r1', name: 'Cat assistant' }],
    });
    tui.addInitiateTaskPane({
      companyId: 'acme',
      roles: [
        { id: 'r1', name: 'Planner' },
        { id: 'r2', name: 'Implementer' },
      ],
      defaultRoleId: 'r1',
    });
  }

  it("opens via 'n' from the company roster", () => {
    const { tui, rows, pressKey } = makeTui();
    tui.addRosterPane({
      id: 'acme',
      label: 'Acme Corp',
      slug: 'acme-corp',
      roles: [{ id: 'r1', name: 'Cat assistant' }],
    });
    const onOpen = jest.fn(() => {
      tui.addInitiateTaskPane({
        companyId: 'acme',
        roles: [],
        defaultRoleId: undefined,
      });
    });
    tui.onOpenInitiateTask(onOpen);

    pressKey('n');

    expect(onOpen).toHaveBeenCalled();
    expect(rows()[0]).toContain('[ New task ]');
  });

  it('pre-selects the default planner role', () => {
    const { tui, text } = makeTui();
    openFromRoster(tui);
    expect(text()).toContain('(*) Planner');
    expect(text()).toContain('( ) Implementer');
  });

  it('types a prompt via Enter-to-edit, then commits on Enter', () => {
    const { tui, text, pressKey, type } = makeTui();
    openFromRoster(tui);

    pressKey('ENTER'); // start editing the prompt (first row)
    type('Write a report');
    pressKey('ENTER'); // commit

    expect(text()).toContain('Prompt: "Write a report"');
  });

  it('adds and removes an expected-output filename', () => {
    const { tui, text, pressKey, type } = makeTui();
    openFromRoster(tui);

    // Navigate down to "+ Add expected output": prompt, 2 roles, then add-row.
    pressKey('DOWN');
    pressKey('DOWN');
    pressKey('DOWN');
    pressKey('ENTER'); // start editing the new filename
    type('output.md');
    pressKey('ENTER'); // commit

    expect(text()).toContain('- output.md (d to remove)');

    // The new row lands at the highlight's position (where "+ Add expected
    // output" used to be), so it's already highlighted — no need to move.
    pressKey('d');

    expect(text()).not.toContain('output.md');
  });

  it('blocks submission with an inline message when the prompt is empty', () => {
    const { tui, text, pressKey } = makeTui();
    openFromRoster(tui);
    const onSubmit = jest.fn();
    tui.onSubmitInitiateTask(onSubmit);

    // Navigate to the Submit row: prompt, 2 roles, add-row, start-toggle, submit.
    for (let i = 0; i < 5; i++) pressKey('DOWN');
    pressKey('ENTER');

    expect(onSubmit).not.toHaveBeenCalled();
    expect(text()).toContain('Enter a prompt before submitting.');
  });

  it('toggles Start immediately', () => {
    const { tui, text, pressKey } = makeTui();
    openFromRoster(tui);

    // Navigate to the start-toggle row: prompt, 2 roles, add-row, start-toggle.
    for (let i = 0; i < 4; i++) pressKey('DOWN');
    expect(text()).toContain('[ ] Start immediately');

    pressKey('ENTER');

    expect(text()).toContain('[x] Start immediately');
  });

  it('submits with the built request once prompt and role are set', () => {
    const { tui, pressKey, type } = makeTui();
    openFromRoster(tui);
    const onSubmit = jest.fn();
    tui.onSubmitInitiateTask(onSubmit);

    pressKey('ENTER');
    type('Write a report');
    pressKey('ENTER');
    for (let i = 0; i < 5; i++) pressKey('DOWN'); // to the Submit row
    pressKey('ENTER');

    expect(onSubmit).toHaveBeenCalledWith(
      '__initiate_task__',
      expect.objectContaining({
        companyId: 'acme',
        request: 'Write a report',
        plannerRoleId: 'r1',
        expected: [],
        startImmediately: false,
      }),
    );
  });

  it('replaceWithTaskPane hands off to the task panel in the same tab slot', () => {
    const { tui, rows } = makeTui();
    openFromRoster(tui);
    const tabCountBefore = rows()[0].split('|').length;

    tui.replaceWithTaskPane('__initiate_task__', {
      id: 'task-1',
      label: 'task-1',
      prompt: 'Write a report',
      status: 'ready',
      assignments: [],
    });

    expect(rows()[0].split('|').length).toBe(tabCountBefore);
    expect(rows()[0]).toContain('[ task-1 ]');
    expect(rows()[CONTENT_TOP]).toContain('Task id:  task-1');
  });
});

describe('Tui closing tabs', () => {
  it('Ctrl+W closes the active non-roster tab and switches focus', () => {
    const { tui, rows, pressKey } = makeTui();
    tui.addRosterPane({
      id: 'acme',
      label: 'Acme Corp',
      slug: 'acme-corp',
      roles: [],
    });
    tui.addPane({ id: 'a', label: 'Cat', talkable: true });
    tui.switchToPane('a');

    pressKey('CTRL_W');

    expect(rows()[0]).not.toContain('Cat');
    expect(rows()[0]).toContain('[ Acme Corp ]');
  });

  it('calls the onCloseTab handler with the closed pane id', () => {
    const { tui, pressKey } = makeTui();
    tui.addRosterPane({
      id: 'acme',
      label: 'Acme Corp',
      slug: 'acme-corp',
      roles: [],
    });
    tui.addPane({ id: 'a', label: 'Cat', talkable: true });
    tui.switchToPane('a');
    const onCloseTab = jest.fn();
    tui.onCloseTab(onCloseTab);

    pressKey('CTRL_W');

    expect(onCloseTab).toHaveBeenCalledWith('a');
  });

  it('does nothing when the active tab is the company roster', () => {
    const { tui, rows, pressKey } = makeTui();
    tui.addRosterPane({
      id: 'acme',
      label: 'Acme Corp',
      slug: 'acme-corp',
      roles: [],
    });
    tui.addPane({ id: 'a', label: 'Cat', talkable: true });
    const onCloseTab = jest.fn();
    tui.onCloseTab(onCloseTab);
    // Active pane is the roster (pane 0, first added).

    pressKey('CTRL_W');

    expect(onCloseTab).not.toHaveBeenCalled();
    expect(rows()[0]).toContain('[ Acme Corp ]');
    expect(rows()[0]).toContain('Cat'); // the 'a' tab is still present
  });

  it("shows the 'Ctrl+W close' hint on closable tabs but not on the roster", () => {
    const { tui, rows, term, pressKey } = makeTui();
    tui.addRosterPane({
      id: 'acme',
      label: 'Acme Corp',
      slug: 'acme-corp',
      roles: [],
    });
    tui.addPane({ id: 'a', label: 'Cat', talkable: true });

    expect(rows()[term.height - 1]).not.toContain('Ctrl+W close');

    pressKey('TAB');
    expect(rows()[term.height - 1]).toContain('Ctrl+W close');
  });

  it('closing one talkable tab leaves another tab and its content intact', () => {
    const { tui, text, pressKey } = makeTui();
    tui.addRosterPane({
      id: 'acme',
      label: 'Acme Corp',
      slug: 'acme-corp',
      roles: [],
    });
    tui.addPane({ id: 'a', label: 'Cat', talkable: true });
    tui.addPane({ id: 'b', label: 'Chicken', talkable: true });
    tui.appendEvent('b', statusEvent('chicken-marker'));
    tui.switchToPane('a');

    pressKey('CTRL_W'); // closes 'a', switches to the next pane in order ('b')

    expect(text()).toContain('chicken-marker');
  });
});

describe('Tui help pane', () => {
  it('F1 opens a help pane and switches to it', () => {
    const { tui, rows, text, pressKey } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });

    pressKey('F1');

    expect(rows()[0]).toContain('[ Help ]');
    expect(text()).toContain('Keyboard shortcuts');
  });

  it('Ctrl+G also opens the help pane — a fallback for when F1 is intercepted (e.g. bound to brightness on Mac laptops)', () => {
    const { tui, rows, pressKey } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });

    pressKey('CTRL_G');

    expect(rows()[0]).toContain('[ Help ]');
  });

  it("shows the 'F1/Ctrl+G help' hint everywhere except on the help pane itself, which shows 'Esc close' instead", () => {
    // A spectator (non-talkable) pane keeps the hint row short enough at
    // width 80 for the low-priority help hint to survive fitHints.
    const { tui, rows, term, pressKey } = makeTui();
    tui.addPane({ id: 'a', label: 'Cat', talkable: true });
    tui.addPane({ id: 'spec', label: 'Chicken', talkable: false });
    pressKey('TAB'); // to the spectator pane
    expect(rows()[term.height - 1]).toContain('F1/Ctrl+G help');

    pressKey('F1');
    expect(rows()[term.height - 1]).not.toContain('F1/Ctrl+G help');
    expect(rows()[term.height - 1]).toContain('Esc close');
  });

  it('Tab away from the help pane closes it rather than just switching away', () => {
    const { tui, rows, pressKey } = makeTui();
    tui.addPane({ id: 'a', label: 'Cat', talkable: true });
    pressKey('F1');
    expect(rows()[0]).toContain('[ Help ]');

    pressKey('TAB');

    expect(rows()[0]).not.toContain('Help');
    expect(rows()[0]).toContain('[ Cat ]');
  });

  it('Shift+Tab away from the help pane also closes it', () => {
    const { tui, rows, pressKey } = makeTui();
    tui.addPane({ id: 'a', label: 'Cat', talkable: true });
    pressKey('F1');

    pressKey('SHIFT_TAB');

    expect(rows()[0]).not.toContain('Help');
    expect(rows()[0]).toContain('[ Cat ]');
  });

  it('Esc closes the help pane and lands on a sensible neighbouring tab', () => {
    const { tui, rows, pressKey } = makeTui();
    tui.addPane({ id: 'a', label: 'Cat', talkable: true });
    pressKey('F1');

    pressKey('ESCAPE');

    expect(rows()[0]).not.toContain('Help');
    expect(rows()[0]).toContain('[ Cat ]');
  });

  it('Esc does nothing when the active pane is not the help pane', () => {
    const { tui, rows, pressKey } = makeTui();
    tui.addPane({ id: 'a', label: 'Cat', talkable: true });

    pressKey('ESCAPE');

    expect(rows()[0]).toContain('[ Cat ]');
  });

  it('Ctrl+W also closes the help pane', () => {
    const { tui, rows, pressKey } = makeTui();
    tui.addPane({ id: 'a', label: 'Cat', talkable: true });
    pressKey('F1');

    pressKey('CTRL_W');

    expect(rows()[0]).not.toContain('Help');
    expect(rows()[0]).toContain('[ Cat ]');
  });

  it('re-opens fresh after being closed, and does not duplicate if opened while already active', () => {
    const { tui, rows, pressKey } = makeTui();
    tui.addPane({ id: 'a', label: 'Cat', talkable: true });

    pressKey('F1');
    pressKey('F1'); // already on the help pane — must not create a second one
    expect(rows()[0].match(/Help/g) ?? []).toHaveLength(1);

    pressKey('TAB'); // closes it
    pressKey('F1'); // re-opens fresh
    expect(rows()[0]).toContain('[ Help ]');
  });
});

describe('Tui quitting', () => {
  it('stops capture, exits fullscreen, and exits the process on Ctrl+C by default', () => {
    const { tui, term, pressKey } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });

    pressKey('CTRL_C');

    expect(term.grabInput).toHaveBeenCalledWith(false);
    expect(term.fullscreen).toHaveBeenCalledWith(false);
    expect(term.processExit).toHaveBeenCalledWith(0);
  });

  it('calls a registered onQuit handler instead of the default behaviour', () => {
    const { tui, term, pressKey } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });
    const onQuit = jest.fn();
    tui.onQuit(onQuit);

    pressKey('CTRL_C');

    expect(onQuit).toHaveBeenCalled();
    expect(term.processExit).not.toHaveBeenCalled();
  });
});

describe('tuiRenderer', () => {
  it('forwards events to the named pane', () => {
    const { tui, text } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });

    const renderer = tuiRenderer(tui, 'root');
    renderer.render(statusEvent('running'));

    expect(text()).toContain('running');
  });

  it('reports responseSeen only after a response event, and finish() is a no-op', () => {
    const { tui } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });

    const renderer = tuiRenderer(tui, 'root');
    expect(renderer.responseSeen).toBe(false);
    renderer.render(deltaEvent('response', 'hi'));
    expect(renderer.responseSeen).toBe(true);
    expect(() => renderer.finish()).not.toThrow();
  });
});
