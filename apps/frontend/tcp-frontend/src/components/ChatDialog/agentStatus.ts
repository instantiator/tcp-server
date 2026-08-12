import { ACTIVE_AGENT_STATUSES } from '../../api/statuses';

/**
 * Whether an agent has finished for good — `completed`, `failed` or
 * `cancelled`.
 *
 * Two things in a chat panel turn on this: the complete button disappears, and
 * the message form stops accepting input. They must agree, so the test lives
 * in one place rather than in each of them.
 *
 * Derived from the active list rather than written out again: `statuses.ts`
 * holds the one product judgement about which statuses mean "still going", and
 * a second copy of the complement here would be the one that goes stale.
 *
 * `undefined` — the status has not been fetched yet — is not finished. A panel
 * that opened with its form disabled and then enabled it a moment later would
 * be worse than one that briefly allows a message the server refuses.
 */
export const isTerminalAgentStatus = (status: string | undefined): boolean =>
  status !== undefined &&
  !(ACTIVE_AGENT_STATUSES as readonly string[]).includes(status);
