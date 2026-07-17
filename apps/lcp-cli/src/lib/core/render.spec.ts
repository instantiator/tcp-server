import { createRenderer, RenderOptions } from './render';

/** A minimal in-memory writable that records everything written to it. */
function fakeStream(): { chunks: string[]; stream: NodeJS.WritableStream } {
  const chunks: string[] = [];
  const stream = {
    write: (s: string) => {
      chunks.push(s);
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { chunks, stream };
}

function setup(overrides: Partial<RenderOptions> = {}) {
  const out = fakeStream();
  const err = fakeStream();
  const renderer = createRenderer({
    hideReasoning: false,
    out: out.stream,
    err: err.stream,
    ...overrides,
  });
  return {
    renderer,
    out,
    err,
    outText: () => out.chunks.join(''),
    errText: () => err.chunks.join(''),
  };
}

describe('createRenderer', () => {
  it('renders an agent_status event on its own coloured line to stderr', () => {
    const { renderer, errText } = setup();
    renderer.render({ kind: 'agent_status', data: { status: 'running' } });
    expect(errText()).toContain('Agent state: running');
  });

  it('includes the reason in an agent_status line when present', () => {
    const { renderer, errText } = setup();
    renderer.render({
      kind: 'agent_status',
      data: { status: 'paused', reason: 'consultation' },
    });
    expect(errText()).toContain('Agent state: paused (consultation)');
  });

  it('renders response deltas to stdout and marks responseSeen', () => {
    const { renderer, outText } = setup();
    renderer.render({ kind: 'response', data: { delta: 'Hello ' } });
    renderer.render({ kind: 'response', data: { delta: 'world' } });
    expect(renderer.responseSeen).toBe(true);
    expect(outText()).toContain('Hello world');
  });

  it('prints the Response prefix once for consecutive response deltas', () => {
    const { renderer, outText } = setup();
    renderer.render({ kind: 'response', data: { delta: 'a' } });
    renderer.render({ kind: 'response', data: { delta: 'b' } });
    const occurrences = outText().split('Response: ').length - 1;
    expect(occurrences).toBe(1);
  });

  it('hides reasoning when hideReasoning is set', () => {
    const { renderer, errText } = setup({ hideReasoning: true });
    renderer.render({ kind: 'reasoning', data: { delta: 'thinking hard' } });
    expect(errText()).not.toContain('thinking hard');
    expect(renderer.responseSeen).toBe(false);
  });

  it('shows reasoning by default on stderr', () => {
    const { renderer, errText } = setup();
    renderer.render({ kind: 'reasoning', data: { delta: 'pondering' } });
    expect(errText()).toContain('Reasoning: ');
    expect(errText()).toContain('pondering');
  });

  it('prefixes lines with the role name when following a consulted agent', () => {
    const { renderer, errText } = setup({ rolePrefix: 'Cat assistant' });
    renderer.render({ kind: 'agent_status', data: { status: 'running' } });
    expect(errText()).toContain('[Cat assistant] Agent state: running');
  });

  it('separates distinct blocks with a blank line', () => {
    const { renderer, errText } = setup();
    renderer.render({ kind: 'agent_status', data: { status: 'running' } });
    renderer.render({ kind: 'llm', data: { activity: 'request_started' } });
    // The second block is preceded by a standalone newline (blank line).
    expect(errText()).toContain('\n');
    expect(errText().indexOf('LLM state:')).toBeGreaterThan(
      errText().indexOf('Agent state:'),
    );
  });

  it('renders an llm tool event with the tool name', () => {
    const { renderer, errText } = setup();
    renderer.render({
      kind: 'llm',
      data: { activity: 'tool_started', tool: 'request_agent_consultation' },
    });
    expect(errText()).toContain(
      'LLM state: tool_started: request_agent_consultation',
    );
  });

  it('renders a consultation_started event as an agent-state line', () => {
    const { renderer, errText } = setup();
    renderer.render({
      kind: 'consultation_started',
      data: { agentId: 'x', roleName: 'Chicken assistant' },
    });
    expect(errText()).toContain('consulting Chicken assistant');
  });

  it('wraps a long discrete line to the terminal width instead of printing it unwrapped', () => {
    // A fixed width, not the real process.stdout.columns — otherwise this
    // test's outcome depends on the terminal the test happens to run in.
    const width = 40;
    const { renderer, errText } = setup({ width });
    const longStatus = Array.from({ length: 20 }, (_, i) => `word${i}`).join(
      ' ',
    );
    renderer.render({ kind: 'agent_status', data: { status: longStatus } });
    const lines = errText().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      // Strip ANSI colour codes before measuring visible width.
      // eslint-disable-next-line no-control-regex
      expect(line.replace(/\x1b\[[0-9;]*m/g, '').length).toBeLessThanOrEqual(
        width,
      );
    }
  });

  it('renders agent_loop_completion with a fixed header, not the payload text as the header', () => {
    const { renderer, errText } = setup();
    renderer.render({
      kind: 'agent_loop_completion',
      data: {
        summary: 'Task completed.\n\nActions taken (in order):\n- did a thing',
      },
    });
    expect(errText()).toContain('assignment complete: Task completed.');
  });

  it('ignores terminal and unknown event kinds', () => {
    const { renderer, outText, errText } = setup();
    renderer.render({ kind: 'completed', data: { response: 'done' } });
    renderer.render({ kind: 'mystery', data: {} });
    expect(outText()).toBe('');
    expect(errText()).toBe('');
  });

  describe('renderUserPrompt', () => {
    it('renders the message on its own coloured line to stderr', () => {
      const { renderer, errText } = setup();
      renderer.renderUserPrompt('What is the capital of France?');
      expect(errText()).toContain('You: What is the capital of France?');
    });

    it('participates in blank-line block spacing with subsequent lines', () => {
      const { renderer, errText } = setup();
      renderer.renderUserPrompt('hi');
      renderer.render({ kind: 'agent_status', data: { status: 'running' } });
      expect(errText().indexOf('Agent state:')).toBeGreaterThan(
        errText().indexOf('You: hi'),
      );
      // A blank-line separator was inserted between the two blocks.
      const between = errText().slice(
        errText().indexOf('You: hi'),
        errText().indexOf('Agent state:'),
      );
      expect(between).toContain('\n');
    });
  });

  describe('blank response marker', () => {
    it('renders (blank) for a single empty-string response delta', () => {
      const { renderer, outText } = setup();
      renderer.render({ kind: 'response', data: { delta: '' } });
      renderer.finish();
      expect(outText()).toContain('(blank)');
    });

    it('renders (blank) when only whitespace deltas arrive', () => {
      const { renderer, outText } = setup();
      renderer.render({ kind: 'response', data: { delta: '   ' } });
      renderer.render({ kind: 'response', data: { delta: '\n' } });
      renderer.finish();
      expect(outText()).toContain('(blank)');
    });

    it('does not render (blank) for a non-empty response', () => {
      const { renderer, outText } = setup();
      renderer.render({ kind: 'response', data: { delta: 'Hello' } });
      renderer.finish();
      expect(outText()).not.toContain('(blank)');
    });

    it('resets the blank check between successive response blocks', () => {
      const { renderer, outText } = setup();
      renderer.render({ kind: 'response', data: { delta: 'Hello' } });
      renderer.render({ kind: 'agent_status', data: { status: 'running' } }); // closes the block
      renderer.render({ kind: 'response', data: { delta: '' } });
      renderer.finish();
      const occurrences = outText().split('(blank)').length - 1;
      expect(occurrences).toBe(1);
    });
  });
});
