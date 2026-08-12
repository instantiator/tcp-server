// Reading a chat message's content as plain text. Its own module, with no
// imports at all, because `client.ts` may only export a value whose whole
// import graph is runtime-free — and its previous home,
// `stream-event-mapper.ts`, imports `AuditEventType` as a value, which drags
// TypeORM in behind it.

/** Extracts a content block's `.text` field, or `''` if it isn't shaped that way. */
function blockText(block: unknown): string {
  if (!block || typeof block !== 'object') return '';
  const text = (block as Record<string, unknown>)['text'];
  return typeof text === 'string' ? text : '';
}

/**
 * Extracts plain text from a chat message's `content` field: a plain string,
 * or an array of content blocks (each with a `.text` field), joined. Shared
 * by tcp-agent (reading a turn's final output text) and the transcript
 * renderers (mapping an agent's audit history back into displayable text) —
 * all of them need to read a chat model message's content from the same shape.
 */
export function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(blockText).join('');
  return '';
}
