// Narrowing for untrusted payloads off the wire. Nothing here trusts a field's
// declared type: an SSE payload that doesn't match its contract must degrade to
// a safe default rather than reach a client and crash it mid-render.

/** Reads a string field from a record, defaulting to ''. */
export function str(
  obj: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = obj?.[key];
  return typeof value === 'string' ? value : '';
}
