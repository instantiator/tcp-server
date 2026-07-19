import { AuditWireEvent, StreamDelta, WireEvent } from '@lcp/shared';
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

function audit(eventType: string, payload: Record<string, unknown>): WireEvent {
  return {
    type: 'audit',
    event: {
      timestamp: '2026-07-19T14:03:22.000Z',
      companyId: 'c',
      role: 'r',
      agentId: 'ag',
      assignmentId: null,
      taskId: null,
      eventType: eventType as AuditWireEvent['eventType'],
      payload,
    },
  };
}

const delta = (channel: 'reasoning' | 'response', d: string): StreamDelta => ({
  type: 'stream',
  agentId: 'ag',
  channel,
  delta: d,
  timestamp: '2026-07-19T14:03:22.000Z',
});

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
    outText: () => out.chunks.join(''),
    errText: () => err.chunks.join(''),
  };
}

describe('createRenderer', () => {
  it('renders a state_change to stderr as a line-only entry', () => {
    const { renderer, errText } = setup();
    renderer.render(
      audit('state_change', { entity: 'agent', newStatus: 'running' }),
    );
    expect(errText()).toContain('state_change:agent | running');
  });

  it('renders response deltas to stdout and marks responseSeen', () => {
    const { renderer, outText } = setup();
    renderer.render(delta('response', 'Hello '));
    renderer.render(delta('response', 'world'));
    renderer.finish();
    expect(renderer.responseSeen).toBe(true);
    expect(outText()).toContain('Hello world');
  });

  it('prints the response block header once for consecutive response deltas', () => {
    const { renderer, outText } = setup();
    renderer.render(delta('response', 'a'));
    renderer.render(delta('response', 'b'));
    renderer.finish();
    const occurrences = outText().split('llm_response:response').length - 1;
    expect(occurrences).toBe(1);
  });

  it('hides reasoning when hideReasoning is set', () => {
    const { renderer, errText } = setup({ hideReasoning: true });
    renderer.render(delta('reasoning', 'thinking hard'));
    renderer.finish();
    expect(errText()).not.toContain('thinking hard');
    expect(renderer.responseSeen).toBe(false);
  });

  it('shows reasoning by default on stderr', () => {
    const { renderer, errText } = setup();
    renderer.render(delta('reasoning', 'pondering'));
    renderer.finish();
    expect(errText()).toContain('llm_response:reasoning');
    expect(errText()).toContain('pondering');
  });

  it('renders a tool_call as a JSON block to stderr with the tool name in its label', () => {
    const { renderer, errText } = setup();
    renderer.render(
      audit('tool_call', { tool: 'web_search', input: { q: 'x' } }),
    );
    expect(errText()).toContain('tool_call:web_search');
    expect(errText()).toContain('"tool": "web_search"');
  });

  it('renders agent_loop_completion with the fixed completion label', () => {
    const { renderer, errText } = setup();
    renderer.render(
      audit('agent_loop_completion', { summary: 'Wrote the report' }),
    );
    expect(errText()).toContain('assignment complete | Wrote the report');
  });

  it('never renders llm_request bodies', () => {
    const { renderer, errText } = setup();
    renderer.render(audit('llm_request', { input: { messages: ['secret'] } }));
    expect(errText()).toContain('llm_request');
    expect(errText()).not.toContain('secret');
  });

  describe('blank response marker', () => {
    it('renders (blank) for an empty response block', () => {
      const { renderer, outText } = setup();
      renderer.render(delta('response', ''));
      renderer.finish();
      expect(outText()).toContain('(blank)');
    });

    it('does not render (blank) for a non-empty response', () => {
      const { renderer, outText } = setup();
      renderer.render(delta('response', 'Hello'));
      renderer.finish();
      expect(outText()).not.toContain('(blank)');
    });
  });
});
