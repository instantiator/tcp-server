// Transcript formatting helpers shared by every client that renders the
// agent event/audit log — split out of the CLI's agent-log-format.ts so the
// browser and the CLI use one implementation instead of two.

/** Whether response text should be displayed as the `(blank)` placeholder. */
export function isBlankText(text: string): boolean {
  return text.trim().length === 0;
}

/**
 * Fixed header label used wherever an `agent_loop_completion` event/audit row
 * is rendered — the deterministic completion text is one loop run's (i.e. one
 * assignment's) completion, not the whole task's, so the header names that
 * explicitly rather than echoing the payload's own leading line (which reads
 * as "Task completed.").
 */
export const ASSIGNMENT_COMPLETE_LABEL = 'assignment complete';

/** Parses `timestamp` as `hh:mm:ss`, or `null` if it's missing/unparsable. */
export function parseClockTime(timestamp: string | undefined): string | null {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toTimeString().slice(0, 8);
}
