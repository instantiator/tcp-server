/**
 * Report emitted by {@link ContextManagerService} when context compaction runs.
 * Included in the chat response so clients can display compaction activity.
 */
export interface CompactionReport {
  /** Names of the compaction strategies that executed (e.g. `'trim_messages'`). */
  strategies: string[];
  /** Human-readable descriptions of each individual action taken. */
  activities: string[];
  /** Wall-clock time taken by the full compaction pass, in milliseconds. */
  duration: number;
  /** Context state before compaction. */
  before: CompactionSnapshot;
  /** Context state after compaction. */
  after: CompactionSnapshot;
}

/** Token-usage snapshot at a point in time. */
export interface CompactionSnapshot {
  /** Estimated token count. */
  tokens: number;
  /** Model context window size in tokens. */
  windowSize: number;
  /** Percentage of the context window consumed (0–100). */
  pct: number;
}
