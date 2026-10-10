/**
 * The agents a user is listening in on, per company, kept in this browser.
 *
 * Eavesdrops have no server record — listening in creates nothing — so the
 * list and its archived flags are a per-viewer convenience (000.06). It follows
 * the user across reloads, not across devices.
 */

/** One agent being listened in on. */
export interface Eavesdrop {
  readonly agentId: string;
  readonly roleName: string;
  /** The assignment's shortcode, or `null` when it wasn't known. */
  readonly reference: string | null;
  /** Hidden from the list unless "Show archived" is ticked. */
  readonly archived: boolean;
}

/** One list per user per company, so two people sharing a browser don't mix. */
export const eavesdropStorageKey = (userId: string, companyId: string) =>
  `tcp.chat.eavesdrops.${userId}.${companyId}`;

const isEavesdrop = (value: unknown): value is Eavesdrop => {
  if (typeof value !== 'object' || value === null) return false;
  const { agentId, roleName, reference, archived } = value as Record<
    string,
    unknown
  >;
  return (
    typeof agentId === 'string' &&
    typeof roleName === 'string' &&
    (typeof reference === 'string' || reference === null) &&
    typeof archived === 'boolean'
  );
};

/**
 * The stored list, or an empty one. Anything malformed is dropped rather than
 * thrown: a corrupt entry must not take the chat dialog down with it.
 */
export const readEavesdrops = (key: string): readonly Eavesdrop[] => {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isEavesdrop) : [];
  } catch {
    return [];
  }
};

/** Persists the list, ignoring a storage backend that refuses to write. */
export const writeEavesdrops = (
  key: string,
  eavesdrops: readonly Eavesdrop[],
): void => {
  try {
    localStorage.setItem(key, JSON.stringify(eavesdrops));
  } catch {
    // Still held in memory for this page view.
  }
};
