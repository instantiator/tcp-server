// An incremental writer for stdout/stderr surfaces (chat, eavesdrop). Subscribes
// to an EventLogBuffer's appends and writes styled lines the moment they arrive,
// routing response content to `out` and everything else to `err` (chat's
// stdout/stderr contract), streaming deltas into an open block and flushing it —
// with the (blank) marker — when the next event arrives. Replaces render.ts's
// createRenderer.

import { isBlankText } from '../core/agent-log-format';
import { renderEntry, LogEntry } from './entries';
import { AppendEvent, EventLogBuffer } from './event-log';
import { HeadingBlockRenderer } from './heading';
import { StyleBackend } from './style';

/** Placeholder written for a whitespace-only or empty response block. */
const BLANK_RESPONSE_MARKER = '(blank)';

export interface StreamPresenterOptions {
  /** Stream for response content (stdout when interactive, stderr for `--query`). */
  out: NodeJS.WritableStream;
  /** Stream for observability content (headings, state, reasoning, tools). */
  err: NodeJS.WritableStream;
  style: StyleBackend;
  /** Wrap width for complete lines/blocks; defaults to `process.stdout.columns ?? 80`. */
  width?: number;
}

/**
 * Writes an {@link EventLogBuffer}'s output incrementally. Complete entries
 * render through {@link renderEntry}; a streamed block opens with its header
 * and then appends raw deltas, closing (and emitting `(blank)` for an empty
 * response) when any later event arrives.
 */
export class StreamPresenter {
  private readonly headingRenderer = new HeadingBlockRenderer();
  private openChannel: 'reasoning' | 'response' | null = null;
  private responseHadContent = false;

  constructor(
    buffer: EventLogBuffer,
    private readonly opts: StreamPresenterOptions,
  ) {
    buffer.onAppend((e) => this.handle(e));
  }

  /** Flushes any open streamed block — call when the stream ends. */
  finish(): void {
    this.closeBlock();
  }

  private get width(): number {
    return this.opts.width ?? process.stdout.columns ?? 80;
  }

  private streamFor(channel: 'reasoning' | 'response'): NodeJS.WritableStream {
    return channel === 'response' ? this.opts.out : this.opts.err;
  }

  /** Closes an open streamed block, emitting `(blank)` for an empty response. */
  private closeBlock(): void {
    if (this.openChannel === null) return;
    if (this.openChannel === 'response' && !this.responseHadContent) {
      this.opts.out.write(
        this.opts.style.paint('response', BLANK_RESPONSE_MARKER),
      );
    }
    this.streamFor(this.openChannel).write('\n');
    this.openChannel = null;
  }

  private handle(e: AppendEvent): void {
    if (e.kind === 'delta') {
      // Extends the open block (opened by its `entry` event); append raw token.
      if (!isBlankText(e.delta)) this.responseHadContent = true;
      this.streamFor(e.channel).write(this.opts.style.escape(e.delta));
      return;
    }

    this.closeBlock();

    if (e.kind === 'heading') {
      for (const line of this.headingRenderer.render(e.info, this.opts.style)) {
        this.opts.err.write(`${line}\n`);
      }
      return;
    }

    if (e.entry.style === 'reasoning' || e.entry.style === 'response') {
      this.openStreamedBlock(e.entry.style, e.entry);
      return;
    }

    // A complete discrete/line entry — always observability (never `out`).
    for (const line of renderEntry(e.entry, this.width, this.opts.style)) {
      this.opts.err.write(`${line}\n`);
    }
  }

  /** Opens a streamed reasoning/response block: header line, then its first text. */
  private openStreamedBlock(
    channel: 'reasoning' | 'response',
    entry: LogEntry,
  ): void {
    const stream = this.streamFor(channel);
    const header = this.opts.style.paint(
      channel,
      `${entry.time} | ${entry.label} |`,
    );
    stream.write(`${header}\n`);
    this.openChannel = channel;
    this.responseHadContent =
      channel === 'response' && !isBlankText(entry.text);
    stream.write(this.opts.style.escape(entry.text));
  }
}
