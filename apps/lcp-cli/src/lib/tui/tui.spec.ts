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

import { EventEmitter } from 'events';
import { ScreenBuffer } from 'terminal-kit';
import { interpretKey, Tui, tuiRenderer, TuiTerminal } from './tui';
import { SseEvent } from '../core/sse';

const WIDTH = 80;
const HEIGHT = 16;
/** Row where a pane's own content (heading, then log/list) begins. */
const CONTENT_TOP = 2;

function makeTui(opts: { hideReasoning?: boolean } = {}) {
  const emitter = new EventEmitter();
  const term = Object.assign(emitter, {
    width: WIDTH,
    height: HEIGHT,
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
    width: WIDTH + 1,
    height: HEIGHT + 1,
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
  return { tui, term, rows, text, attrAt, pressKey, type };
}

function statusEvent(status: string): SseEvent {
  return {
    kind: 'agent_status',
    timestamp: new Date().toISOString(),
    data: { status },
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

describe('Tui rendering', () => {
  it('shows the pane label as the active tab on the top row', () => {
    const { tui, rows } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat Assistant', talkable: true });
    expect(rows()[0]).toContain('[ Cat Assistant ]');
  });

  it('opens each chat pane with a Name/Id heading, falling back to the pane id', () => {
    const { tui, rows } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });
    expect(rows()[CONTENT_TOP]).toContain('Name: Cat');
    expect(rows()[CONTENT_TOP + 1]).toContain('Id: root');
  });

  it("uses the role's own id in the heading when roleId is given, not the pane (agent) id", () => {
    const { tui, rows } = makeTui();
    tui.addPane({
      id: 'agent-1',
      label: 'Cat',
      talkable: true,
      roleId: 'role-xyz',
    });
    expect(rows()[CONTENT_TOP + 1]).toContain('Id: role-xyz');
  });

  it('renders appended discrete events into the pane scrollback', () => {
    const { tui, text } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });
    tui.appendEvent('root', statusEvent('running'));
    expect(text()).toMatch(/\d\d:\d\d:\d\d \| agent_status \| running/);
  });

  it('accumulates reasoning deltas as one indented block', () => {
    const { tui, text } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });
    for (const delta of ['thinking', ' about', ' kibble']) {
      tui.appendEvent('root', {
        kind: 'reasoning',
        timestamp: new Date().toISOString(),
        data: { delta },
      });
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
    tui.appendEvent('root', {
      kind: 'reasoning',
      timestamp: new Date().toISOString(),
      data: { delta: 'thinking' },
    });
    // Heading occupies 3 rows (Name, Id, blank) above the log content.
    const firstLogRow = CONTENT_TOP + 3;
    expect(text()).toContain('thinking');
    expect(attrAt(2, firstLogRow).char).toBe('t');
    expect(attrAt(2, firstLogRow).attr.color).toBe(8); // bright black (^K)
  });

  it('does not render raw markup codes as visible text', () => {
    const { tui, text } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });
    tui.appendEvent('root', {
      kind: 'reasoning',
      timestamp: new Date().toISOString(),
      data: { delta: 'thinking' },
    });
    expect(text()).not.toContain('^K');
    expect(text()).not.toContain('^:');
  });

  it('escapes a literal caret in model-provided text so it displays as one caret, not a corrupted colour', () => {
    const { tui, text } = makeTui();
    tui.addPane({ id: 'root', label: 'Cat', talkable: true });
    tui.appendEvent('root', {
      kind: 'response',
      timestamp: new Date().toISOString(),
      data: { delta: 'x^2 + y^2' },
    });
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

  it('opens with a Slug/Id heading, a prompt, and a blank line before the list', () => {
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
    expect(rows()[CONTENT_TOP + 5]).toContain('> Cat assistant');
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
    const selectedRow = CONTENT_TOP + 5;
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
    renderer.render({
      kind: 'response',
      timestamp: new Date().toISOString(),
      data: { delta: 'hi' },
    });
    expect(renderer.responseSeen).toBe(true);
    expect(() => renderer.finish()).not.toThrow();
  });
});
