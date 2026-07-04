import type { Terminal } from 'terminal-kit';
import { interpretKey, Tui, tuiRenderer, TuiWidgetClasses } from './tui';

describe('interpretKey', () => {
  it('maps CTRL_RIGHT to next-pane', () => {
    expect(interpretKey('CTRL_RIGHT')).toBe('next-pane');
  });

  it('maps CTRL_LEFT to prev-pane', () => {
    expect(interpretKey('CTRL_LEFT')).toBe('prev-pane');
  });

  it('maps CTRL_C to quit', () => {
    expect(interpretKey('CTRL_C')).toBe('quit');
  });

  it('maps an ordinary character to none, so it reaches the input box unchanged', () => {
    expect(interpretKey('a')).toBe('none');
    expect(interpretKey('ENTER')).toBe('none');
  });
});

/** Minimal fake terminal-kit `Terminal`: only what `Tui` actually calls. */
function makeFakeTerm() {
  const keyHandlers: Array<(name: string) => void> = [];
  const resizeHandlers: Array<() => void> = [];
  const callable = jest.fn();
  const fake = Object.assign(callable, {
    width: 80,
    height: 24,
    fullscreen: jest.fn(),
    grabInput: jest.fn(),
    processExit: jest.fn(),
    moveTo: jest.fn(),
    eraseLine: jest.fn(),
    on: jest.fn((event: string, handler: (...a: unknown[]) => void) => {
      if (event === 'key') keyHandlers.push(handler);
      if (event === 'resize') resizeHandlers.push(handler);
    }),
  });
  return { fake: fake as unknown as Terminal, keyHandlers, resizeHandlers };
}

/** Minimal fake terminal-kit widget classes: track construction and calls. */
function makeFakeWidgets() {
  class FakeElement {
    outputWidth = 80;
    outputHeight = 20;
    shown = false;
    destroyed = false;
    handlers = new Map<string, (...args: unknown[]) => void>();
    constructor(public options: Record<string, unknown>) {}
    show(): void {
      this.shown = true;
    }
    hide(): void {
      this.shown = false;
    }
    destroy(): void {
      this.destroyed = true;
    }
    on(event: string, handler: (...args: unknown[]) => void): void {
      this.handlers.set(event, handler);
    }
  }

  // Each widget kind tracks its own instances — a shared base-class static
  // array would alias Container/TextBox/InlineInput/Document together, since
  // JS static properties are inherited down the prototype chain unless a
  // subclass redeclares its own.
  class FakeDocument extends FakeElement {
    static instances: FakeDocument[] = [];
    focused: unknown = null;
    constructor(options: Record<string, unknown>) {
      super(options);
      FakeDocument.instances.push(this);
    }
    giveFocusTo(el: unknown): void {
      this.focused = el;
    }
  }

  class FakeContainer extends FakeElement {
    static instances: FakeContainer[] = [];
    resizeCalls: unknown[] = [];
    constructor(options: Record<string, unknown>) {
      super(options);
      FakeContainer.instances.push(this);
    }
    resize(to: unknown): void {
      this.resizeCalls.push(to);
    }
  }

  class FakeTextBox extends FakeElement {
    static instances: FakeTextBox[] = [];
    content = '';
    constructor(options: Record<string, unknown>) {
      super(options);
      FakeTextBox.instances.push(this);
    }
    setContent(content: string): void {
      this.content = content;
    }
    scrollToBottom(): void {
      // no-op for the fake
    }
  }

  class FakeInlineInput extends FakeElement {
    static instances: FakeInlineInput[] = [];
    constructor(options: Record<string, unknown>) {
      super(options);
      FakeInlineInput.instances.push(this);
    }
    getValue(): string {
      return '';
    }
  }

  const widgets: TuiWidgetClasses = {
    Document: FakeDocument as unknown as TuiWidgetClasses['Document'],
    Container: FakeContainer as unknown as TuiWidgetClasses['Container'],
    TextBox: FakeTextBox as unknown as TuiWidgetClasses['TextBox'],
    InlineInput: FakeInlineInput as unknown as TuiWidgetClasses['InlineInput'],
  };

  return { widgets, FakeContainer, FakeTextBox, FakeInlineInput, FakeElement };
}

describe('Tui', () => {
  it('enters fullscreen and grabs input on construction', () => {
    const { fake } = makeFakeTerm();
    const { widgets } = makeFakeWidgets();
    new Tui({ term: fake, widgets });
    expect(fake.fullscreen).toHaveBeenCalledWith(true);
    expect(fake.grabInput).toHaveBeenCalledWith(true);
  });

  it('creates a container and text box for each added pane', () => {
    const { fake } = makeFakeTerm();
    const { widgets, FakeContainer, FakeTextBox } = makeFakeWidgets();
    const tui = new Tui({ term: fake, widgets });
    tui.addPane({ id: 'root', label: 'chicken', talkable: true });
    expect(FakeContainer.instances).toHaveLength(1);
    expect(FakeTextBox.instances).toHaveLength(1);
  });

  it('shows only the active pane and creates an input box only when it is talkable', () => {
    const { fake } = makeFakeTerm();
    const { widgets, FakeContainer, FakeInlineInput } = makeFakeWidgets();
    const tui = new Tui({ term: fake, widgets });
    tui.addPane({ id: 'root', label: 'chicken', talkable: true });
    tui.addPane({ id: 'cat', label: 'cat', talkable: false });

    const [rootContainer, catContainer] = FakeContainer.instances;
    expect(rootContainer.shown).toBe(true);
    expect(catContainer.shown).toBe(false);
    expect(FakeInlineInput.instances).toHaveLength(1);
  });

  it('does not rebuild the input box when a new (non-active) pane is added, so mid-typed text survives', () => {
    const { fake } = makeFakeTerm();
    const { widgets, FakeInlineInput } = makeFakeWidgets();
    const tui = new Tui({ term: fake, widgets });
    tui.addPane({ id: 'root', label: 'chicken', talkable: true });
    expect(FakeInlineInput.instances).toHaveLength(1);
    const original = FakeInlineInput.instances[0];

    tui.addPane({ id: 'cat', label: 'cat', talkable: false });

    expect(FakeInlineInput.instances).toHaveLength(1);
    expect(FakeInlineInput.instances[0]).toBe(original);
    expect(original.destroyed).toBe(false);
  });

  it('rebuilds the input box after a submit, even though the active pane is unchanged', () => {
    const { fake } = makeFakeTerm();
    const { widgets, FakeInlineInput } = makeFakeWidgets();
    const tui = new Tui({ term: fake, widgets });
    tui.addPane({ id: 'root', label: 'chicken', talkable: true });
    const original = FakeInlineInput.instances[0];

    original.handlers.get('submit')!('hello');

    expect(original.destroyed).toBe(true);
    expect(FakeInlineInput.instances).toHaveLength(2);
    expect(FakeInlineInput.instances[1].destroyed).toBe(false);
  });

  it('destroys the input box when switching to a non-talkable pane', () => {
    const { fake, keyHandlers } = makeFakeTerm();
    const { widgets, FakeInlineInput } = makeFakeWidgets();
    const tui = new Tui({ term: fake, widgets });
    tui.addPane({ id: 'root', label: 'chicken', talkable: true });
    tui.addPane({ id: 'cat', label: 'cat', talkable: false });

    expect(FakeInlineInput.instances).toHaveLength(1);
    keyHandlers[0]('CTRL_RIGHT'); // switch to the (non-talkable) cat pane
    expect(FakeInlineInput.instances[0].destroyed).toBe(true);
  });

  it('destroys the pane container on removePane', () => {
    const { fake } = makeFakeTerm();
    const { widgets, FakeContainer } = makeFakeWidgets();
    const tui = new Tui({ term: fake, widgets });
    tui.addPane({ id: 'root', label: 'chicken', talkable: true });
    tui.addPane({ id: 'cat', label: 'cat', talkable: false });
    tui.removePane('cat');
    expect(FakeContainer.instances[1].destroyed).toBe(true);
  });

  it('quits (stops capture, exits fullscreen, and exits the process) on CTRL_C', () => {
    const { fake, keyHandlers } = makeFakeTerm();
    const { widgets } = makeFakeWidgets();
    const tui = new Tui({ term: fake, widgets });
    tui.addPane({ id: 'root', label: 'chicken', talkable: true });

    keyHandlers[0]('CTRL_C');
    expect(fake.grabInput).toHaveBeenCalledWith(false);
    expect(fake.fullscreen).toHaveBeenCalledWith(false);
    expect(fake.processExit).toHaveBeenCalledWith(0);
  });

  it('calls a registered onQuit handler instead of the default stop-and-exit behaviour', () => {
    const { fake, keyHandlers } = makeFakeTerm();
    const { widgets } = makeFakeWidgets();
    const tui = new Tui({ term: fake, widgets });
    tui.addPane({ id: 'root', label: 'chicken', talkable: true });
    const onQuit = jest.fn();
    tui.onQuit(onQuit);

    keyHandlers[0]('CTRL_C');

    expect(onQuit).toHaveBeenCalled();
    expect(fake.processExit).not.toHaveBeenCalled();
  });

  it('renders appended events into the active pane text box', () => {
    const { fake } = makeFakeTerm();
    const { widgets, FakeTextBox } = makeFakeWidgets();
    const tui = new Tui({ term: fake, widgets });
    tui.addPane({ id: 'root', label: 'chicken', talkable: true });
    tui.appendEvent('root', {
      kind: 'agent_status',
      timestamp: new Date().toISOString(),
      data: { status: 'running' },
    });
    expect(FakeTextBox.instances[0].content).toContain('agent_status');
    expect(FakeTextBox.instances[0].content).toContain('running');
  });

  it('calls the submit handler with the trimmed input value', () => {
    const { fake } = makeFakeTerm();
    const { widgets, FakeInlineInput } = makeFakeWidgets();
    const tui = new Tui({ term: fake, widgets });
    tui.addPane({ id: 'root', label: 'chicken', talkable: true });
    const onSubmit = jest.fn();
    tui.onSubmit(onSubmit);

    const input = FakeInlineInput.instances[0];
    const submit = input.handlers.get('submit')!;
    submit('  hello  ');
    expect(onSubmit).toHaveBeenCalledWith('hello');
  });
});

describe('tuiRenderer', () => {
  it('forwards events to the named pane', () => {
    const { fake } = makeFakeTerm();
    const { widgets, FakeTextBox } = makeFakeWidgets();
    const tui = new Tui({ term: fake, widgets });
    tui.addPane({ id: 'root', label: 'chicken', talkable: true });

    const renderer = tuiRenderer(tui, 'root');
    renderer.render({
      kind: 'agent_status',
      timestamp: new Date().toISOString(),
      data: { status: 'running' },
    });

    expect(FakeTextBox.instances[0].content).toContain('running');
  });

  it('reports responseSeen only after a response event, and finish() is a no-op', () => {
    const { fake } = makeFakeTerm();
    const { widgets } = makeFakeWidgets();
    const tui = new Tui({ term: fake, widgets });
    tui.addPane({ id: 'root', label: 'chicken', talkable: true });

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
