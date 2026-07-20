/**
 * Matches a canonical UUID (case-insensitive) — the shape reserved for
 * auto-generated ids. Used to reject a UUID-shaped value in a human-chosen
 * identifier field (e.g. `slug`), so it can never collide with an id — the
 * ambiguity that would otherwise confuse id-vs-slug resolution (e.g.
 * lcp-cli's `--company`/`--role`, which treats a UUID-shaped value as an id
 * and anything else as a slug). See `IsNotUuid` (`apps/lcp-server`) for the
 * validator built on this.
 */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
