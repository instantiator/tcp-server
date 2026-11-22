/**
 * Limits on a role's memories (002.06), shared by the `remember` tool, the
 * memory routes' DTOs and the web client's form. A memory is meant to be one
 * short fact, so the caps are generous for that and stop pasted documents.
 *
 * Imports nothing, so the web client may take these as values.
 */

/** The longest a memory's content may be, in characters. */
export const MAX_MEMORY_LENGTH = 2000;

/** The most tags one memory may carry. */
export const MAX_MEMORY_TAGS = 10;

/** The longest one tag may be, in characters. */
export const MAX_MEMORY_TAG_LENGTH = 40;

/**
 * Cosine similarity at or above which `remember` treats a new memory as one
 * the role already has, and refuses it. ponytail: a guess; tune it when
 * duplicates appear in a role's table or a distinct memory is refused.
 */
export const DUPLICATE_MEMORY_SIMILARITY = 0.92;
