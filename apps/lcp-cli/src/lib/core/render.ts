// The Renderer seam chat's streamAgent/runTurn control flow drives, now a thin
// adapter over the shared render library (EventLogBuffer + StreamPresenter) —
// the same pipeline the TUI panes and eavesdrop use. Kept as a seam so that
// control flow stays identical between piped-output and TUI modes; only which
// Renderer is constructed differs (see tuiRenderer in tui.ts).

import { WireEvent } from '@lcp/shared';
import { EventLogBuffer } from '../render/event-log';
import { StreamPresenter } from '../render/stream-presenter';
import { ansiStyle, plainStyle } from '../render/style';

export interface RenderOptions {
  /** Suppress reasoning blocks when true. */
  hideReasoning: boolean;
  /** Stream for response content (stdout when interactive, stderr for --query). */
  out: NodeJS.WritableStream;
  /** Stream for observability content (state, reasoning, LLM activity). */
  err: NodeJS.WritableStream;
  /** Wrap width for discrete lines. Defaults to `process.stdout.columns ?? 80`. */
  width?: number;
}

export interface Renderer {
  /** Renders one wire event (audit row or stream delta); terminal detection is the caller's. */
  render(event: WireEvent): void;
  /** Whether any response delta has been rendered (drives the completed-event fallback). */
  readonly responseSeen: boolean;
  /** Flushes any open streamed block so the next output starts cleanly. */
  finish(): void;
}

/**
 * Builds a stdout/stderr {@link Renderer} backed by an {@link EventLogBuffer}
 * and {@link StreamPresenter}. Single-scope (chat is one agent per stream), so
 * no scope heading blocks are emitted.
 */
export function createRenderer(opts: RenderOptions): Renderer {
  const buffer = new EventLogBuffer(() => ({}), opts.hideReasoning, false);
  const presenter = new StreamPresenter(buffer, {
    out: opts.out,
    err: opts.err,
    style:
      opts.out === process.stdout && process.stdout.isTTY
        ? ansiStyle
        : plainStyle,
    width: opts.width,
  });
  let responseSeen = false;
  return {
    render(event: WireEvent): void {
      if (event.type === 'stream') {
        if (event.channel === 'response') responseSeen = true;
        buffer.appendDelta(event);
      } else {
        buffer.appendAudit(event.event);
      }
    },
    get responseSeen(): boolean {
      return responseSeen;
    },
    finish(): void {
      presenter.finish();
    },
  };
}
