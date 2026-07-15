// Renders the agent event stream to a terminal with colour-coded, blank-line
// separated blocks. Kept separate from the chat command so the block/colour
// logic can be unit-tested without a live SSE stream.

import { formatCompactionEvent, SseEvent } from './sse';

// Raw ANSI codes — no colour dependency. Bright cyan for agent state, bright
// magenta for LLM state, grey for reasoning, white for response, bright
// green for the user's own input.
const AGENT_COLOR = '\x1b[96m';
const LLM_COLOR = '\x1b[95m';
const REASONING_COLOR = '\x1b[90m';
const RESPONSE_COLOR = '\x1b[37m';
const USER_COLOR = '\x1b[92m';
const RESET = '\x1b[0m';

/** Placeholder printed in place of a whitespace-only or empty response. */
const BLANK_RESPONSE_MARKER = '(blank)';

export interface RenderOptions {
  /** Suppress reasoning blocks when true. */
  hideReasoning: boolean;
  /** Role name to prefix lines with when following a consulted agent. */
  rolePrefix?: string;
  /** Stream for response content (stdout when interactive, stderr for --query). */
  out: NodeJS.WritableStream;
  /** Stream for observability lines (state, reasoning, LLM activity). */
  err: NodeJS.WritableStream;
}

export interface Renderer {
  /** Renders one non-terminal event; terminal events are handled by the caller. */
  render(event: SseEvent): void;
  /** Whether any response delta has been rendered (drives completed-event dedupe). */
  readonly responseSeen: boolean;
  /** Closes any open delta block so the next output starts cleanly. */
  finish(): void;
  /**
   * Renders the user's own submitted message as a distinctly-coloured
   * discrete line, participating in the same blank-line spacing as every
   * other line. No-op for renderers that echo user input another way.
   */
  renderUserPrompt(text: string): void;
}

/** Reads a string field from an event's data payload, defaulting to ''. */
function str(data: Record<string, unknown> | undefined, key: string): string {
  const value = data?.[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Builds a stateful renderer for one agent's event stream. Consecutive
 * reasoning/response deltas append to the same block without re-printing their
 * prefix; every other event kind is its own blank-line-separated line.
 */
export function createRenderer(opts: RenderOptions): Renderer {
  const label = opts.rolePrefix ? `[${opts.rolePrefix}] ` : '';
  let currentBlock: 'reasoning' | 'response' | null = null;
  let hasOutput = false;
  let responseSeen = false;
  let responseHadContent = false;

  /** Ends an open delta block with a reset + newline. */
  function closeBlock(): void {
    if (currentBlock === 'response') {
      if (!responseHadContent) opts.out.write(BLANK_RESPONSE_MARKER);
      opts.out.write(RESET + '\n');
    } else if (currentBlock === 'reasoning') {
      opts.err.write(RESET + '\n');
    }
    currentBlock = null;
  }

  /** Writes a self-contained coloured line for a discrete (non-delta) event. */
  function discreteLine(
    stream: NodeJS.WritableStream,
    color: string,
    text: string,
  ): void {
    closeBlock();
    if (hasOutput) stream.write('\n');
    stream.write(`${color}${label}${text}${RESET}\n`);
    hasOutput = true;
  }

  /** Opens (or continues) a delta block, printing the prefix on first delta. */
  function appendDelta(
    kind: 'reasoning' | 'response',
    stream: NodeJS.WritableStream,
    color: string,
    prefix: string,
    delta: string,
  ): void {
    if (currentBlock !== kind) {
      closeBlock();
      if (hasOutput) stream.write('\n');
      stream.write(`${color}${label}${prefix}`);
      currentBlock = kind;
      hasOutput = true;
      if (kind === 'response') responseHadContent = false;
    }
    if (kind === 'response' && delta.trim().length > 0) {
      responseHadContent = true;
    }
    stream.write(delta);
  }

  function render(event: SseEvent): void {
    const data = event.data;
    switch (event.kind) {
      case 'agent_status': {
        const status = str(data, 'status');
        const reason = str(data, 'reason');
        const text = reason ? `${status} (${reason})` : status;
        discreteLine(opts.err, AGENT_COLOR, `Agent state: ${text}`);
        break;
      }
      case 'consultation_started': {
        const roleName = str(data, 'roleName');
        discreteLine(
          opts.err,
          AGENT_COLOR,
          `Agent state: consulting ${roleName}…`,
        );
        break;
      }
      case 'llm': {
        const activity = str(data, 'activity');
        const tool = str(data, 'tool');
        const text = tool ? `${activity}: ${tool}` : activity;
        discreteLine(opts.err, LLM_COLOR, `LLM state: ${text}`);
        break;
      }
      case 'reasoning': {
        if (opts.hideReasoning) break;
        // Indent continuation lines to keep the block visually distinct.
        const delta = str(data, 'delta').replace(/\n/g, '\n  ');
        appendDelta(
          'reasoning',
          opts.err,
          REASONING_COLOR,
          'Reasoning: ',
          delta,
        );
        break;
      }
      case 'response': {
        responseSeen = true;
        appendDelta(
          'response',
          opts.out,
          RESPONSE_COLOR,
          'Response: ',
          str(data, 'delta'),
        );
        break;
      }
      case 'compaction_started':
      case 'compaction_complete': {
        const line = formatCompactionEvent(event);
        if (line) discreteLine(opts.err, REASONING_COLOR, line);
        break;
      }
      default:
        // Unknown kinds (including terminal completed/failed) are ignored here.
        break;
    }
  }

  function renderUserPrompt(text: string): void {
    discreteLine(opts.err, USER_COLOR, `You: ${text}`);
  }

  return {
    render,
    get responseSeen() {
      return responseSeen;
    },
    finish: closeBlock,
    renderUserPrompt,
  };
}
